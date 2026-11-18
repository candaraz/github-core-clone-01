// Entry point: the HTTP server, the router, the git smart-HTTP handler, and
// the harness lifecycle (bind an ephemeral port, register it, poll for done).

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// Server is the whole forge: one store, one bearer token.
type Server struct {
	store *Store
	token string
}

func (s *Server) authed(r *http.Request) bool {
	if s.token == "" {
		return true
	}
	return r.Header.Get("Authorization") == "Bearer "+s.token
}

// ServeHTTP routes every request: health, REST, GraphQL, MCP, git, or 404.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/healthz":
		if r.Method != http.MethodGet {
			s.writeErr(w, http.StatusNotFound, "Not Found")
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case path == "/api/v3" || strings.HasPrefix(path, "/api/v3/"):
		s.handleREST(w, r)
	case path == "/api/graphql":
		s.handleGraphQL(w, r)
	case path == "/mcp":
		s.handleMCP(w, r)
	default:
		if owner, repo, rest, ok := parseGitPath(path); ok {
			s.handleGit(w, r, owner, repo, rest)
			return
		}
		s.writeErr(w, http.StatusNotFound, "Not Found")
	}
}

// --- git smart HTTP ---

func (s *Server) writeGitBytes(w http.ResponseWriter, status int, contentType string, body []byte) {
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("X-GitHub-Request-Id", s.store.nextRequestID())
	h.Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(status)
	w.Write(body)
}

func (s *Server) writeGitText(w http.ResponseWriter, status int, text string) {
	s.writeGitBytes(w, status, "text/plain", []byte(text))
}

func (s *Server) handleGit(w http.ResponseWriter, r *http.Request, owner, repoName, rest string) {
	switch {
	case rest == "info/refs" && r.Method == http.MethodGet:
		s.gitInfoRefs(w, r, owner, repoName)
	case rest == "git-upload-pack" && r.Method == http.MethodPost:
		s.gitUploadPack(w, r, owner, repoName)
	case rest == "git-receive-pack" && r.Method == http.MethodPost:
		s.gitReceivePack(w, r, owner, repoName)
	default:
		s.writeGitText(w, http.StatusNotFound, "Not Found")
	}
}

func (s *Server) gitInfoRefs(w http.ResponseWriter, r *http.Request, owner, repoName string) {
	service := r.URL.Query().Get("service")
	s.store.mu.RLock()
	repo := s.store.lookup(owner, repoName)
	var body []byte
	var contentType string
	if repo == nil {
		s.store.mu.RUnlock()
		s.writeGitText(w, http.StatusNotFound, "Not Found")
		return
	}
	switch service {
	case "git-upload-pack":
		contentType = "application/x-git-upload-pack-advertisement"
		if strings.Contains(r.Header.Get("Git-Protocol"), "version=2") {
			body = v2AdvertisementBytes
		} else {
			body = v0UploadAdvertisement(repo)
		}
	case "git-receive-pack":
		contentType = "application/x-git-receive-pack-advertisement"
		body = v0ReceiveAdvertisement(repo)
	default:
		s.store.mu.RUnlock()
		s.writeGitText(w, http.StatusBadRequest, "unknown service")
		return
	}
	s.store.mu.RUnlock()
	s.writeGitBytes(w, http.StatusOK, contentType, body)
}

func (s *Server) gitUploadPack(w http.ResponseWriter, r *http.Request, owner, repoName string) {
	body := readBody(r)
	packets, err := parsePktLines(body)
	if err != nil || len(packets) == 0 {
		s.writeGitText(w, http.StatusBadRequest, "malformed pkt-line stream")
		return
	}
	first := packets[0]
	if first.kind != pktData {
		s.writeGitText(w, http.StatusBadRequest, "malformed pkt-line stream")
		return
	}
	head := string(first.payload)
	switch {
	case strings.HasPrefix(head, "command="):
		s.gitV2Command(w, body, owner, repoName)
	case strings.HasPrefix(head, "want "):
		s.gitV0Fetch(w, body, owner, repoName)
	default:
		s.writeGitText(w, http.StatusBadRequest, "unknown upload-pack request")
	}
}

func (s *Server) gitV2Command(w http.ResponseWriter, body []byte, owner, repoName string) {
	command, _, post, err := parseV2Command(body)
	if err != nil {
		s.writeGitText(w, http.StatusBadRequest, "malformed v2 request")
		return
	}
	switch command {
	case "ls-refs":
		s.gitLsRefs(w, parseLsRefsArgs(post), owner, repoName)
	case "fetch":
		s.gitFetch(w, parseFetchArgsV2(post), "v2", owner, repoName)
	default:
		s.writeGitText(w, http.StatusBadRequest, "unknown v2 command: "+command)
	}
}

func (s *Server) gitLsRefs(w http.ResponseWriter, args lsRefsArgs, owner, repoName string) {
	key := args.key()
	s.store.mu.RLock()
	repo := s.store.lookup(owner, repoName)
	var cached []byte
	var version uint64
	if repo != nil {
		cached = repo.lsCache[key]
		version = repo.Version
	}
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeGitText(w, http.StatusNotFound, "Not Found")
		return
	}
	if cached != nil {
		s.writeGitBytes(w, http.StatusOK, "application/x-git-upload-pack-result", cached)
		return
	}
	s.store.mu.RLock()
	response := lsRefsResponse(repo, args)
	version = repo.Version
	s.store.mu.RUnlock()
	s.store.mu.Lock()
	// Only cache when the repo did not change while the response was built.
	if repo.Version == version {
		if repo.lsCache == nil {
			repo.lsCache = map[string][]byte{}
		}
		if len(repo.lsCache) > 16 {
			repo.lsCache = map[string][]byte{}
		}
		repo.lsCache[key] = response
	}
	s.store.mu.Unlock()
	s.writeGitBytes(w, http.StatusOK, "application/x-git-upload-pack-result", response)
}

func (s *Server) gitFetch(w http.ResponseWriter, args fetchArgs, protocol, owner, repoName string) {
	key := args.key(protocol)
	s.store.mu.RLock()
	repo := s.store.lookup(owner, repoName)
	var cached []byte
	if repo != nil {
		cached = repo.fetchCache[key]
	}
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeGitText(w, http.StatusNotFound, "Not Found")
		return
	}
	if cached != nil {
		s.writeGitBytes(w, http.StatusOK, "application/x-git-upload-pack-result", cached)
		return
	}
	s.store.mu.RLock()
	var response []byte
	if protocol == "v2" {
		response = fetchResponseV2(repo, args)
	} else {
		response = fetchResponseV0(repo, args)
	}
	version := repo.Version
	s.store.mu.RUnlock()
	s.store.mu.Lock()
	if repo.Version == version {
		if repo.fetchCache == nil {
			repo.fetchCache = map[string][]byte{}
		}
		if len(repo.fetchCache) > 16 {
			repo.fetchCache = map[string][]byte{}
		}
		repo.fetchCache[key] = response
	}
	s.store.mu.Unlock()
	s.writeGitBytes(w, http.StatusOK, "application/x-git-upload-pack-result", response)
}

func (s *Server) gitV0Fetch(w http.ResponseWriter, body []byte, owner, repoName string) {
	args, err := parseFetchArgsV0(body)
	if err != nil {
		s.writeGitText(w, http.StatusBadRequest, "malformed v0 fetch")
		return
	}
	s.gitFetch(w, args, "v0", owner, repoName)
}

func (s *Server) gitReceivePack(w http.ResponseWriter, r *http.Request, owner, repoName string) {
	body := readBody(r)
	commands, caps, pack, err := parsePushBody(body)
	if err != nil {
		s.writeGitText(w, http.StatusBadRequest, "malformed push body")
		return
	}
	s.store.mu.Lock()
	repo := s.store.lookup(owner, repoName)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeGitText(w, http.StatusNotFound, "Not Found")
		return
	}
	unpackOK, detail, reports := repo.applyPush(commands, pack)
	s.store.mu.Unlock()
	response := pushReport(unpackOK, detail, reports, caps["side-band-64k"])
	s.writeGitBytes(w, http.StatusOK, "application/x-git-receive-pack-result", response)
}

// --- lifecycle ---

func main() {
	runtime.GOMAXPROCS(2)
	envURL := strings.TrimSuffix(os.Getenv("MAKEFUN_ENV_URL"), "/")
	if envURL == "" {
		fmt.Fprintln(os.Stderr, "MAKEFUN_ENV_URL is not set")
		os.Exit(1)
	}
	server := &Server{
		store: NewStore(),
		token: os.Getenv("MAKEFUN_SHOP_TOKEN"),
	}
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	fmt.Printf("forge listening on port %d\n", port)

	httpServer := &http.Server{Handler: server}
	go func() {
		_ = httpServer.Serve(listener)
	}()

	// Graceful exit on signals.
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		_ = httpServer.Close()
		os.Exit(0)
	}()

	client := &http.Client{Timeout: 30 * time.Second}
	if !register(client, envURL, port) {
		fmt.Fprintln(os.Stderr, "registration failed")
		os.Exit(1)
	}
	pollDone(client, envURL)
	_ = httpServer.Close()
	os.Exit(0)
}

// register POSTs {"port": N} until the environment accepts it. 400/405 are
// fatal; anything else (including 409, which means another entry already
// registered) is retried with backoff (250ms doubling to a 2s cap), exactly
// as the kit's starter lifecycle does.
func register(client *http.Client, envURL string, port int) bool {
	payload, _ := json.Marshal(map[string]int{"port": port})
	backoff := 250 * time.Millisecond
	for {
		req, err := http.NewRequest(http.MethodPost, envURL+"/register", bytes.NewReader(payload))
		if err != nil {
			return false
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			switch {
			case resp.StatusCode >= 200 && resp.StatusCode < 300:
				return true
			case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusMethodNotAllowed:
				return false
			}
		}
		time.Sleep(backoff)
		backoff *= 2
		if backoff > 2*time.Second {
			backoff = 2 * time.Second
		}
	}
}

// pollDone GETs /done until the environment reports completion.
func pollDone(client *http.Client, envURL string) {
	for {
		req, err := http.NewRequest(http.MethodGet, envURL+"/done", nil)
		if err != nil {
			return
		}
		resp, err := client.Do(req)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var done struct {
				Done bool `json:"done"`
			}
			if json.Unmarshal(body, &done) == nil && done.Done {
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}
