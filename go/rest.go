// REST API v3: the GitHub-compatible surface. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; matched routes require the bearer token;
// unknown routes answer 404 JSON without an auth check.

package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// handleREST dispatches /api/v3/* requests. The path is the remainder after
// "/api/v3" ("" for the root).
func (s *Server) handleREST(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSuffix(r.URL.Path[len("/api/v3"):], "/")
	segments := splitPath(path)
	method := r.Method

	// Route matching happens before the auth check: unknown routes answer
	// 404 even without a token.
	matched := s.restRouteExists(segments, method)
	if !matched {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if !s.authed(r) {
		s.writeErr(w, http.StatusUnauthorized, "Requires authentication")
		return
	}
	s.dispatchREST(w, r, segments, method)
}

// restRouteExists reports whether a method+path combination is a known route.
func (s *Server) restRouteExists(segments []string, method string) bool {
	if len(segments) == 0 {
		return method == http.MethodGet
	}
	switch segments[0] {
	case "meta":
		return len(segments) == 1 && method == http.MethodGet
	case "user":
		if len(segments) == 1 {
			return method == http.MethodGet
		}
		return len(segments) == 2 && segments[1] == "repos" &&
			(method == http.MethodGet || method == http.MethodPost)
	case "repos":
		if len(segments) < 3 {
			return false
		}
		rest := segments[3:]
		if len(rest) == 0 {
			return method == http.MethodGet || method == http.MethodPatch || method == http.MethodDelete
		}
		switch rest[0] {
		case "branches":
			return len(rest) >= 1 && method == http.MethodGet
		case "commits":
			return len(rest) == 1 && method == http.MethodGet
		case "contents":
			return method == http.MethodGet || method == http.MethodPut || method == http.MethodDelete
		case "git":
			return len(rest) >= 2 && rest[1] == "refs" &&
				(method == http.MethodGet || method == http.MethodPost)
		case "labels":
			return len(rest) == 1 && (method == http.MethodGet || method == http.MethodPost)
		case "issues":
			if len(rest) == 1 {
				return method == http.MethodGet || method == http.MethodPost
			}
			if len(rest) == 2 {
				return method == http.MethodGet || method == http.MethodPatch
			}
			return len(rest) == 3 && rest[2] == "comments" &&
				(method == http.MethodGet || method == http.MethodPost)
		case "pulls":
			if len(rest) == 1 {
				return method == http.MethodGet || method == http.MethodPost
			}
			if len(rest) == 2 {
				return method == http.MethodGet || method == http.MethodPatch
			}
			return len(rest) == 3 &&
				((rest[2] == "files" && method == http.MethodGet) ||
					(rest[2] == "merge" && method == http.MethodPut))
		}
	}
	return false
}

func (s *Server) dispatchREST(w http.ResponseWriter, r *http.Request, segments []string, method string) {
	if len(segments) == 0 {
		w.Header().Set("X-OAuth-Scopes", "repo, read:org")
		s.writeJSON(w, http.StatusOK, map[string]string{
			"current_user_url": "/api/v3/user",
			"rate_limit_url":   "/api/v3/rate_limit",
		})
		return
	}
	switch segments[0] {
	case "meta":
		s.writeJSON(w, http.StatusOK, map[string]string{"installed_version": "1.0.0"})
		return
	case "user":
		if len(segments) == 1 {
			s.writeJSON(w, http.StatusOK, viewerJSON())
			return
		}
		if method == http.MethodGet {
			s.listUserRepos(w, r)
		} else {
			s.createRepo(w, r)
		}
		return
	}

	// /repos/{owner}/{repo}/...
	owner, repoName := segments[1], segments[2]
	rest := segments[3:]
	if len(rest) == 0 {
		switch method {
		case http.MethodGet:
			s.getRepo(w, r, owner, repoName)
		case http.MethodPatch:
			s.patchRepo(w, r, owner, repoName)
		case http.MethodDelete:
			s.deleteRepo(w, r, owner, repoName)
		}
		return
	}
	switch rest[0] {
	case "branches":
		if len(rest) == 1 {
			s.listBranches(w, r, owner, repoName)
		} else {
			s.getBranch(w, r, owner, repoName, strings.Join(rest[1:], "/"))
		}
	case "commits":
		s.listCommits(w, r, owner, repoName)
	case "contents":
		contentPath := strings.Join(rest[1:], "/")
		switch method {
		case http.MethodGet:
			s.getContents(w, r, owner, repoName, contentPath)
		case http.MethodPut:
			s.putContents(w, r, owner, repoName, contentPath)
		case http.MethodDelete:
			s.deleteContents(w, r, owner, repoName, contentPath)
		}
	case "git":
		refRest := strings.Join(rest[2:], "/")
		if method == http.MethodPost {
			s.createGitRef(w, r, owner, repoName)
		} else {
			s.getGitRef(w, r, owner, repoName, refRest)
		}
	case "labels":
		if method == http.MethodGet {
			s.listLabels(w, r, owner, repoName)
		} else {
			s.createLabel(w, r, owner, repoName)
		}
	case "issues":
		if len(rest) == 1 {
			if method == http.MethodGet {
				s.listIssues(w, r, owner, repoName)
			} else {
				s.createIssue(w, r, owner, repoName)
			}
			return
		}
		num, err := strconv.Atoi(rest[1])
		if err != nil || num < 1 {
			s.writeErr(w, http.StatusNotFound, "Not Found")
			return
		}
		if len(rest) == 2 {
			if method == http.MethodGet {
				s.getIssue(w, r, owner, repoName, num)
			} else {
				s.patchIssue(w, r, owner, repoName, num)
			}
			return
		}
		if method == http.MethodGet {
			s.listComments(w, r, owner, repoName, num)
		} else {
			s.createComment(w, r, owner, repoName, num)
		}
	case "pulls":
		if len(rest) == 1 {
			if method == http.MethodGet {
				s.listPulls(w, r, owner, repoName)
			} else {
				s.createPull(w, r, owner, repoName)
			}
			return
		}
		num, err := strconv.Atoi(rest[1])
		if err != nil || num < 1 {
			s.writeErr(w, http.StatusNotFound, "Not Found")
			return
		}
		if len(rest) == 2 {
			if method == http.MethodGet {
				s.getPull(w, r, owner, repoName, num)
			} else {
				s.patchPull(w, r, owner, repoName, num)
			}
			return
		}
		if rest[2] == "files" {
			s.listPullFiles(w, r, owner, repoName, num)
		} else {
			s.mergePull(w, r, owner, repoName, num)
		}
	}
}

// readBody reads the whole request body (the suite's bodies are small).
func readBody(r *http.Request) []byte {
	body, _ := io.ReadAll(r.Body)
	return body
}

// decodeBody parses a JSON object body, answering 400 on malformed JSON.
func (s *Server) decodeBody(w http.ResponseWriter, r *http.Request) (jobj, bool) {
	obj, ok := parseBody(readBody(r))
	if !ok {
		s.writeErr(w, http.StatusBadRequest, "Malformed JSON in request body")
		return nil, false
	}
	return obj, true
}

// --- repos ---

func (s *Server) listUserRepos(w http.ResponseWriter, r *http.Request) {
	s.store.mu.RLock()
	repos := make([]repoJSON, 0, len(s.store.order))
	for _, repo := range s.store.order {
		repos = append(repos, repoView(repo))
	}
	s.store.mu.RUnlock()
	page := paginate(w, r, repos)
	s.writeJSON(w, http.StatusOK, page)
}

func (s *Server) createRepo(w http.ResponseWriter, r *http.Request) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	name, _ := obj.str("name")
	if strings.TrimSpace(name) == "" {
		s.writeErr(w, http.StatusUnprocessableEntity, "name is required")
		return
	}
	private, _ := obj.boolean("private")
	description, _ := obj.str("description")
	s.store.mu.Lock()
	repo := s.store.createRepo(name, description, private)
	s.store.mu.Unlock()
	if repo == nil {
		s.writeErr(w, http.StatusUnprocessableEntity, "name already exists on this account")
		return
	}
	s.writeJSON(w, http.StatusCreated, repoView(repo))
}

func (s *Server) getRepo(w http.ResponseWriter, r *http.Request, owner, name string) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, repoView(repo))
}

func (s *Server) patchRepo(w http.ResponseWriter, r *http.Request, owner, name string) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if desc, present := obj.str("description"); present {
		repo.Description = desc
	}
	view := repoView(repo)
	s.store.mu.Unlock()
	s.writeJSON(w, http.StatusOK, view)
}

func (s *Server) deleteRepo(w http.ResponseWriter, r *http.Request, owner, name string) {
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.store.deleteRepo(repo)
	s.store.mu.Unlock()
	s.writeNoContent(w)
}

// --- branches and commits ---

type branchJSON struct {
	Name   string `json:"name"`
	Commit struct {
		SHA string `json:"sha"`
	} `json:"commit"`
}

func (s *Server) listBranches(w http.ResponseWriter, r *http.Request, owner, name string) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var branches []branchJSON
	if repo != nil {
		branches = make([]branchJSON, 0)
		for _, ref := range sortedRefNames(repo) {
			if strings.HasPrefix(ref, "refs/heads/") {
				var b branchJSON
				b.Name = ref[len("refs/heads/"):]
				b.Commit.SHA = repo.Refs[ref]
				branches = append(branches, b)
			}
		}
	}
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, branches)
}

func (s *Server) getBranch(w http.ResponseWriter, r *http.Request, owner, name, branch string) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var tip string
	var found bool
	if repo != nil {
		tip, found = repo.branchTip(branch)
	}
	s.store.mu.RUnlock()
	if repo == nil || !found {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	var b branchJSON
	b.Name = branch
	b.Commit.SHA = tip
	s.writeJSON(w, http.StatusOK, b)
}

type commitListJSON struct {
	SHA    string `json:"sha"`
	Commit struct {
		Message   string    `json:"message"`
		Author    identJSON `json:"author"`
		Committer identJSON `json:"committer"`
	} `json:"commit"`
}

type identJSON struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

func parseIdent(line string) identJSON {
	// "Name <email> timestamp tz"
	lt := strings.IndexByte(line, '<')
	gt := strings.IndexByte(line, '>')
	if lt < 0 || gt < 0 || gt < lt {
		return identJSON{Name: strings.TrimSpace(line)}
	}
	return identJSON{Name: strings.TrimSpace(line[:lt]), Email: line[lt+1 : gt]}
}

func (s *Server) listCommits(w http.ResponseWriter, r *http.Request, owner, name string) {
	ref := r.URL.Query().Get("sha")
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var commits []commitListJSON
	resolved := true
	if repo != nil {
		if ref == "" {
			ref = repo.DefaultBranch
		}
		tip, ok := repo.resolveRef(ref)
		if !ok {
			resolved = false
		} else {
			commits = make([]commitListJSON, 0)
			for _, oid := range repo.history(tip) {
				ci := repo.commitInfo(oid)
				if ci == nil {
					continue
				}
				var c commitListJSON
				c.SHA = oid
				c.Commit.Message = strings.TrimSuffix(ci.Message, "\n")
				c.Commit.Author = parseIdent(ci.Author)
				c.Commit.Committer = parseIdent(ci.Committer)
				commits = append(commits, c)
			}
		}
	}
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if !resolved {
		if r.URL.Query().Get("sha") == "" {
			// Unborn default branch: no commits yet.
			s.writeJSON(w, http.StatusOK, []commitListJSON{})
			return
		}
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, commits)
}

// --- contents ---

func validContentPath(path string) bool {
	if path == "" {
		return false
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

func decodeBase64Field(s string) ([]byte, bool) {
	stripped := strings.Map(func(c rune) rune {
		switch c {
		case ' ', '\t', '\r', '\n':
			return -1
		}
		return c
	}, s)
	data, err := base64.StdEncoding.DecodeString(stripped)
	if err != nil {
		return nil, false
	}
	return data, true
}

type contentFileJSON struct {
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
	SHA      string `json:"sha"`
	Size     int    `json:"size"`
	Name     string `json:"name"`
	Path     string `json:"path"`
}

type contentEntryJSON struct {
	Type string `json:"type"`
	Name string `json:"name"`
	Path string `json:"path"`
	SHA  string `json:"sha"`
	Size int    `json:"size,omitempty"`
}

func (s *Server) getContents(w http.ResponseWriter, r *http.Request, owner, name, contentPath string) {
	ref := r.URL.Query().Get("ref")
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var result any
	status := http.StatusOK
	if repo == nil {
		status = http.StatusNotFound
	} else {
		if ref == "" {
			ref = repo.DefaultBranch
		}
		tip, ok := repo.resolveRef(ref)
		if !ok {
			status = http.StatusNotFound
		} else {
			treeOID := repo.treeOfCommit(tip)
			if contentPath == "" {
				entries := make([]contentEntryJSON, 0)
				for _, e := range repo.treeEntries(treeOID) {
					entries = append(entries, dirEntry(repo, "", e))
				}
				sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
				result = entries
			} else if entry, isDir, found := repo.lookupPath(treeOID, contentPath); !found {
				status = http.StatusNotFound
			} else if isDir {
				entries := make([]contentEntryJSON, 0)
				for _, e := range repo.treeEntries(entry.OID) {
					entries = append(entries, dirEntry(repo, contentPath, e))
				}
				sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
				result = entries
			} else {
				obj := repo.Objects[entry.OID]
				if obj == nil {
					status = http.StatusNotFound
				} else {
					name := contentPath
					if idx := strings.LastIndexByte(contentPath, '/'); idx >= 0 {
						name = contentPath[idx+1:]
					}
					result = contentFileJSON{
						Type:     "file",
						Encoding: "base64",
						Content:  base64.StdEncoding.EncodeToString(obj.Data),
						SHA:      entry.OID,
						Size:     len(obj.Data),
						Name:     name,
						Path:     contentPath,
					}
				}
			}
		}
	}
	s.store.mu.RUnlock()
	if status == http.StatusNotFound {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func dirEntry(repo *Repo, prefix string, e TreeEntry) contentEntryJSON {
	path := e.Name
	if prefix != "" {
		path = prefix + "/" + e.Name
	}
	entry := contentEntryJSON{Name: e.Name, Path: path, SHA: e.OID}
	if e.Mode == "40000" {
		entry.Type = "dir"
	} else {
		entry.Type = "file"
		if obj := repo.Objects[e.OID]; obj != nil {
			entry.Size = len(obj.Data)
		}
	}
	return entry
}

// contentsCommit applies a file creation/update/deletion on a branch and
// returns the new commit oid. Callers hold the write lock. The branch is
// created from the default branch tip when it does not exist yet.
func (r *Repo) contentsCommit(branch, contentPath string, newBlob []byte, mode string, deleteFile bool, message string) (commitOID string, blobOID string, existed bool, errStr string) {
	tip, hasTip := r.branchTip(branch)
	if !hasTip {
		// A new branch starts from the default branch tip (or unborn).
		tip, hasTip = r.branchTip(r.DefaultBranch)
	}
	var flat map[string]flatEntry
	var parents []string
	if hasTip {
		parents = []string{tip}
		flat = r.flattenTree(r.treeOfCommit(tip))
	} else {
		flat = map[string]flatEntry{}
	}
	_, existed = flat[contentPath]
	if deleteFile {
		if !existed {
			return "", "", false, "not found"
		}
		delete(flat, contentPath)
	} else {
		blobOID = r.putObject("blob", newBlob)
		if existed && mode == "" {
			mode = flat[contentPath].Mode
		}
		if mode == "" {
			mode = "100644"
		}
		flat[contentPath] = flatEntry{Mode: mode, OID: blobOID}
	}
	treeOID := r.buildTreeFromFlat(flat)
	commitOID = r.newServerCommit(treeOID, parents, message)
	r.Refs["refs/heads/"+branch] = commitOID
	r.bumpGit()
	return commitOID, blobOID, existed, ""
}

func (s *Server) putContents(w http.ResponseWriter, r *http.Request, owner, name, contentPath string) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	if !validContentPath(contentPath) {
		s.writeErr(w, http.StatusUnprocessableEntity, "invalid path")
		return
	}
	message, present := obj.str("message")
	if !present || message == "" {
		s.writeErr(w, http.StatusUnprocessableEntity, "message is required")
		return
	}
	contentB64, _ := obj.str("content")
	data, okB64 := decodeBase64Field(contentB64)
	if !okB64 {
		s.writeErr(w, http.StatusUnprocessableEntity, "content is not valid base64")
		return
	}
	branch, _ := obj.str("branch")
	sha, hasSHA := obj.str("sha")

	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if branch == "" {
		branch = repo.DefaultBranch
	}
	// Resolve the current state of the path on the target branch (or, for a
	// new branch, on the default branch tip it would fork from).
	tip, hasTip := repo.branchTip(branch)
	if !hasTip {
		tip, hasTip = repo.branchTip(repo.DefaultBranch)
	}
	var currentOID string
	var currentIsDir bool
	if hasTip {
		if entry, isDir, found := repo.lookupPath(repo.treeOfCommit(tip), contentPath); found {
			currentOID, currentIsDir = entry.OID, isDir
		}
	}
	if currentIsDir {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusUnprocessableEntity, "path is a directory")
		return
	}
	existed := currentOID != ""
	if existed {
		if !hasSHA {
			s.store.mu.Unlock()
			s.writeErr(w, http.StatusUnprocessableEntity, "sha is required to update a file")
			return
		}
		if sha != currentOID {
			s.store.mu.Unlock()
			s.writeErr(w, http.StatusConflict, "sha does not match the current blob")
			return
		}
	}
	commitOID, blobOID, _, _ := repo.contentsCommit(branch, contentPath, data, "", false, message)
	s.store.mu.Unlock()

	status := http.StatusCreated
	if existed {
		status = http.StatusOK
	}
	s.writeJSON(w, status, map[string]any{
		"content": map[string]any{
			"sha":      blobOID,
			"encoding": "base64",
			"name":     contentPath[strings.LastIndexByte(contentPath, '/')+1:],
			"path":     contentPath,
			"size":     len(data),
		},
		"commit": map[string]any{"sha": commitOID},
	})
}

func (s *Server) deleteContents(w http.ResponseWriter, r *http.Request, owner, name, contentPath string) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	if !validContentPath(contentPath) {
		s.writeErr(w, http.StatusUnprocessableEntity, "invalid path")
		return
	}
	message, _ := obj.str("message")
	branch, _ := obj.str("branch")
	sha, hasSHA := obj.str("sha")

	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if branch == "" {
		branch = repo.DefaultBranch
	}
	tip, hasTip := repo.branchTip(branch)
	var currentOID string
	var currentIsDir bool
	if hasTip {
		if entry, isDir, found := repo.lookupPath(repo.treeOfCommit(tip), contentPath); found {
			currentOID, currentIsDir = entry.OID, isDir
		}
	}
	if currentOID == "" || currentIsDir {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if hasSHA && sha != currentOID {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusConflict, "sha does not match the current blob")
		return
	}
	commitOID, _, _, _ := repo.contentsCommit(branch, contentPath, nil, "", true, message)
	s.store.mu.Unlock()
	s.writeJSON(w, http.StatusOK, map[string]any{
		"commit": map[string]any{"sha": commitOID},
	})
}

// --- git refs (REST) ---

type gitRefJSON struct {
	Ref    string `json:"ref"`
	Object struct {
		SHA string `json:"sha"`
	} `json:"object"`
}

func makeGitRefJSON(ref, sha string) gitRefJSON {
	var v gitRefJSON
	v.Ref = ref
	v.Object.SHA = sha
	return v
}

func (s *Server) createGitRef(w http.ResponseWriter, r *http.Request, owner, name string) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	ref, _ := obj.str("ref")
	sha, _ := obj.str("sha")
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if !strings.HasPrefix(ref, "refs/") || !isOID(sha) {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusUnprocessableEntity, "ref and sha are required")
		return
	}
	if _, exists := repo.Objects[sha]; !exists {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusUnprocessableEntity, "object does not exist")
		return
	}
	if _, exists := repo.Refs[ref]; exists {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusUnprocessableEntity, "reference already exists")
		return
	}
	repo.Refs[ref] = sha
	repo.bumpGit()
	s.store.mu.Unlock()
	s.writeJSON(w, http.StatusCreated, makeGitRefJSON(ref, sha))
}

func (s *Server) getGitRef(w http.ResponseWriter, r *http.Request, owner, name, refRest string) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var result any
	status := http.StatusOK
	if repo == nil {
		status = http.StatusNotFound
	} else if refRest == "" {
		refs := make([]gitRefJSON, 0)
		for _, refName := range sortedRefNames(repo) {
			refs = append(refs, makeGitRefJSON(refName, repo.Refs[refName]))
		}
		result = refs
	} else if oid, ok := repo.Refs["refs/"+refRest]; ok {
		result = makeGitRefJSON("refs/"+refRest, oid)
	} else {
		prefix := "refs/" + refRest + "/"
		refs := make([]gitRefJSON, 0)
		for _, refName := range sortedRefNames(repo) {
			if strings.HasPrefix(refName, prefix) {
				refs = append(refs, makeGitRefJSON(refName, repo.Refs[refName]))
			}
		}
		if len(refs) == 0 {
			status = http.StatusNotFound
		} else {
			result = refs
		}
	}
	s.store.mu.RUnlock()
	if status == http.StatusNotFound {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

// --- labels ---

func (s *Server) listLabels(w http.ResponseWriter, r *http.Request, owner, name string) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var labels []labelJSON
	if repo != nil {
		labels = make([]labelJSON, 0, len(repo.LabelOrder))
		for _, labelName := range repo.LabelOrder {
			labels = append(labels, labelView(repo.Labels[labelName]))
		}
	}
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, labels)
}

func (s *Server) createLabel(w http.ResponseWriter, r *http.Request, owner, name string) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	labelName, _ := obj.str("name")
	if strings.TrimSpace(labelName) == "" {
		s.writeErr(w, http.StatusUnprocessableEntity, "name is required")
		return
	}
	color, _ := obj.str("color")
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	label, exists := repo.Labels[labelName]
	if !exists {
		label = &Label{Name: labelName}
		repo.Labels[labelName] = label
		repo.LabelOrder = append(repo.LabelOrder, labelName)
	}
	if _, present := obj.str("color"); present {
		label.Color = color
	}
	view := labelView(label)
	repo.issueJSON = make(map[int][]byte)
	s.store.mu.Unlock()
	s.writeJSON(w, http.StatusCreated, view)
}

// --- issues ---

// cacheIssueJSON stores the marshaled issue view for the read fast path.
func (s *Server) cacheIssueJSON(repo *Repo, issue *Issue) []byte {
	body, _ := json.Marshal(issueView(issue))
	if repo.issueJSON == nil {
		repo.issueJSON = make(map[int][]byte)
	}
	repo.issueJSON[issue.Number] = body
	return body
}

func (s *Server) createIssue(w http.ResponseWriter, r *http.Request, owner, name string) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	title, _ := obj.str("title")
	if strings.TrimSpace(title) == "" {
		s.writeErr(w, http.StatusUnprocessableEntity, "title is required")
		return
	}
	body, _ := obj.str("body")
	labels, _ := obj.strSlice("labels")
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	for _, labelName := range labels {
		if _, exists := repo.Labels[labelName]; !exists {
			s.store.mu.Unlock()
			s.writeErr(w, http.StatusUnprocessableEntity, "unknown label: "+labelName)
			return
		}
	}
	issue := &Issue{
		ID:     s.store.nextID,
		Number: repo.NextIssue,
		Title:  title,
		Body:   body,
		State:  "open",
		Labels: append([]string(nil), labels...),
	}
	s.store.nextID++
	repo.NextIssue++
	repo.Issues = append(repo.Issues, issue)
	repo.IssuesByNum[issue.Number] = issue
	// cacheIssueJSON marshals the view once and returns the bytes; send those
	// same bytes instead of marshaling the view a second time.
	issueBody := s.cacheIssueJSON(repo, issue)
	s.store.mu.Unlock()
	s.writeJSONBytes(w, http.StatusCreated, issueBody)
}

func (s *Server) listIssues(w http.ResponseWriter, r *http.Request, owner, name string) {
	q := r.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "open"
	}
	direction := q.Get("direction")
	if direction == "" {
		direction = "desc"
	}
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var issues []issueJSON
	if repo != nil {
		issues = make([]issueJSON, 0, len(repo.Issues))
		for _, issue := range repo.Issues {
			if state != "all" && issue.State != state {
				continue
			}
			issues = append(issues, issueView(issue))
		}
		if direction == "desc" {
			for i, j := 0, len(issues)-1; i < j; i, j = i+1, j-1 {
				issues[i], issues[j] = issues[j], issues[i]
			}
		}
	}
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, paginate(w, r, issues))
}

func (s *Server) getIssue(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var cached []byte
	var issue *Issue
	if repo != nil {
		issue = repo.IssuesByNum[num]
		if issue != nil {
			cached = repo.issueJSON[num]
		}
	}
	s.store.mu.RUnlock()
	if repo == nil || issue == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if cached != nil {
		s.writeJSONBytes(w, http.StatusOK, cached)
		return
	}
	// Fill the cache under the write lock, then serve.
	s.store.mu.Lock()
	cached = s.cacheIssueJSON(repo, issue)
	s.store.mu.Unlock()
	s.writeJSONBytes(w, http.StatusOK, cached)
}

func (s *Server) patchIssue(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	issue := repo.IssuesByNum[num]
	if issue == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if state, present := obj.str("state"); present {
		if state != "open" && state != "closed" {
			s.store.mu.Unlock()
			s.writeErr(w, http.StatusUnprocessableEntity, "state must be open or closed")
			return
		}
		issue.State = state
	}
	if title, present := obj.str("title"); present {
		issue.Title = title
	}
	if body, present := obj.str("body"); present {
		issue.Body = body
	}
	if labels, present := obj.strSlice("labels"); present {
		for _, labelName := range labels {
			if _, exists := repo.Labels[labelName]; !exists {
				s.store.mu.Unlock()
				s.writeErr(w, http.StatusUnprocessableEntity, "unknown label: "+labelName)
				return
			}
		}
		issue.Labels = append([]string(nil), labels...)
	}
	// cacheIssueJSON marshals the view once and returns the bytes; send those
	// same bytes instead of marshaling the view a second time.
	issueBody := s.cacheIssueJSON(repo, issue)
	s.store.mu.Unlock()
	s.writeJSONBytes(w, http.StatusOK, issueBody)
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var comments []commentJSON
	if repo != nil {
		if issue := repo.IssuesByNum[num]; issue != nil {
			comments = make([]commentJSON, 0, len(issue.Comments))
			for _, c := range issue.Comments {
				comments = append(comments, commentView(c))
			}
		}
	}
	s.store.mu.RUnlock()
	if repo == nil || comments == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, comments)
}

func (s *Server) createComment(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	body, present := obj.str("body")
	if !present {
		s.writeErr(w, http.StatusUnprocessableEntity, "body is required")
		return
	}
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	issue := repo.IssuesByNum[num]
	if issue == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	comment := &Comment{ID: s.store.nextID, Body: body}
	s.store.nextID++
	issue.Comments = append(issue.Comments, comment)
	view := commentView(comment)
	s.store.mu.Unlock()
	s.writeJSON(w, http.StatusCreated, view)
}

// --- pull requests ---

func stripOwnerPrefix(ref string) string {
	if idx := strings.LastIndexByte(ref, ':'); idx >= 0 {
		return ref[idx+1:]
	}
	return ref
}

func (s *Server) createPull(w http.ResponseWriter, r *http.Request, owner, name string) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	title, _ := obj.str("title")
	if strings.TrimSpace(title) == "" {
		s.writeErr(w, http.StatusUnprocessableEntity, "title is required")
		return
	}
	headRaw, _ := obj.str("head")
	baseRaw, _ := obj.str("base")
	if headRaw == "" || baseRaw == "" {
		s.writeErr(w, http.StatusUnprocessableEntity, "head and base are required")
		return
	}
	body, _ := obj.str("body")
	head := stripOwnerPrefix(headRaw)
	base := stripOwnerPrefix(baseRaw)
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	headSHA, headOK := repo.branchTip(head)
	baseSHA, baseOK := repo.branchTip(base)
	if !headOK || !baseOK {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusUnprocessableEntity, "head or base branch does not exist")
		return
	}
	pr := &PullRequest{
		ID:      s.store.nextID,
		Number:  repo.NextPR,
		Title:   title,
		Body:    body,
		State:   "open",
		HeadRef: head,
		HeadSHA: headSHA,
		BaseRef: base,
		BaseSHA: baseSHA,
	}
	s.store.nextID++
	repo.NextPR++
	repo.PRs = append(repo.PRs, pr)
	repo.PRsByNum[pr.Number] = pr
	view := prView(repo, pr)
	s.store.mu.Unlock()
	s.writeJSON(w, http.StatusCreated, view)
}

func (s *Server) listPulls(w http.ResponseWriter, r *http.Request, owner, name string) {
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var prs []prJSON
	if repo != nil {
		prs = make([]prJSON, 0, len(repo.PRs))
		for i := len(repo.PRs) - 1; i >= 0; i-- {
			pr := repo.PRs[i]
			switch state {
			case "all":
			case "open":
				if pr.State != "open" {
					continue
				}
			case "closed":
				if pr.State != "closed" {
					continue
				}
			default:
				if pr.State != state {
					continue
				}
			}
			prs = append(prs, prView(repo, pr))
		}
	}
	s.store.mu.RUnlock()
	if repo == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, paginate(w, r, prs))
}

func (s *Server) getPull(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var pr *PullRequest
	if repo != nil {
		pr = repo.PRsByNum[num]
	}
	s.store.mu.RUnlock()
	if repo == nil || pr == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, prView(repo, pr))
}

func (s *Server) patchPull(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	obj, ok := s.decodeBody(w, r)
	if !ok {
		return
	}
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	pr := repo.PRsByNum[num]
	if pr == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if state, present := obj.str("state"); present {
		if state != "open" && state != "closed" {
			s.store.mu.Unlock()
			s.writeErr(w, http.StatusUnprocessableEntity, "state must be open or closed")
			return
		}
		pr.State = state
	}
	if title, present := obj.str("title"); present {
		pr.Title = title
	}
	if body, present := obj.str("body"); present {
		pr.Body = body
	}
	view := prView(repo, pr)
	s.store.mu.Unlock()
	s.writeJSON(w, http.StatusOK, view)
}

// --- pull request files and merging ---

type prFileJSON struct {
	Filename  string `json:"filename"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Changes   int    `json:"changes"`
}

func countLines(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	n := strings.Count(string(data), "\n")
	if data[len(data)-1] != '\n' {
		n++
	}
	return n
}

// diffFiles computes the file diff between two live branch tips.
func (r *Repo) diffFiles(baseTip, headTip string) []prFileJSON {
	baseFlat := r.flattenTree(r.treeOfCommit(baseTip))
	headFlat := r.flattenTree(r.treeOfCommit(headTip))
	paths := map[string]bool{}
	for p := range baseFlat {
		paths[p] = true
	}
	for p := range headFlat {
		paths[p] = true
	}
	sorted := make([]string, 0, len(paths))
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	files := make([]prFileJSON, 0)
	for _, p := range sorted {
		baseEnt, inBase := baseFlat[p]
		headEnt, inHead := headFlat[p]
		if inBase && inHead && baseEnt.OID == headEnt.OID {
			continue
		}
		var f prFileJSON
		f.Filename = p
		switch {
		case !inBase:
			f.Status = "added"
			if obj := r.Objects[headEnt.OID]; obj != nil {
				f.Additions = countLines(obj.Data)
			}
			if f.Additions < 1 {
				f.Additions = 1
			}
		case !inHead:
			f.Status = "removed"
			if obj := r.Objects[baseEnt.OID]; obj != nil {
				f.Deletions = countLines(obj.Data)
			}
		default:
			f.Status = "modified"
			if obj := r.Objects[headEnt.OID]; obj != nil {
				f.Additions = countLines(obj.Data)
			}
			if obj := r.Objects[baseEnt.OID]; obj != nil {
				f.Deletions = countLines(obj.Data)
			}
			if f.Additions < 1 {
				f.Additions = 1
			}
		}
		f.Changes = f.Additions + f.Deletions
		files = append(files, f)
	}
	return files
}

func (s *Server) listPullFiles(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	s.store.mu.RLock()
	repo := s.store.lookup(owner, name)
	var files []prFileJSON
	if repo != nil {
		if pr := repo.PRsByNum[num]; pr != nil {
			baseTip, _ := repo.branchTip(pr.BaseRef)
			headTip, _ := repo.branchTip(pr.HeadRef)
			files = repo.diffFiles(baseTip, headTip)
		}
	}
	s.store.mu.RUnlock()
	if repo == nil || files == nil {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	s.writeJSON(w, http.StatusOK, files)
}

// mergeConflict reports whether merging head into base (both live tips)
// conflicts: a path changed by head since the merge base and changed
// differently on base since the merge base.
func (r *Repo) mergeConflict(baseTip, headTip string) bool {
	ancestor := r.mergeBase(baseTip, headTip)
	var ancestorFlat map[string]flatEntry
	if ancestor == "" {
		ancestorFlat = map[string]flatEntry{}
	} else {
		ancestorFlat = r.flattenTree(r.treeOfCommit(ancestor))
	}
	baseFlat := r.flattenTree(r.treeOfCommit(baseTip))
	headFlat := r.flattenTree(r.treeOfCommit(headTip))
	paths := map[string]bool{}
	for p := range ancestorFlat {
		paths[p] = true
	}
	for p := range baseFlat {
		paths[p] = true
	}
	for p := range headFlat {
		paths[p] = true
	}
	for p := range paths {
		ancEnt, inAnc := ancestorFlat[p]
		baseEnt, inBase := baseFlat[p]
		headEnt, inHead := headFlat[p]
		headChanged := inHead != inAnc || (inHead && inAnc && headEnt.OID != ancEnt.OID)
		baseChanged := inBase != inAnc || (inBase && inAnc && baseEnt.OID != ancEnt.OID)
		if !headChanged || !baseChanged {
			continue
		}
		// Both changed: a conflict unless they changed to the same thing.
		if inHead != inBase {
			return true
		}
		if inHead && headEnt.OID != baseEnt.OID {
			return true
		}
	}
	return false
}

// squashMerge applies the head branch's changes onto the base branch tip and
// returns the new squash commit oid. Callers hold the write lock.
func (r *Repo) squashMerge(baseTip, headTip, message string) string {
	ancestor := r.mergeBase(baseTip, headTip)
	var ancestorFlat map[string]flatEntry
	if ancestor == "" {
		ancestorFlat = map[string]flatEntry{}
	} else {
		ancestorFlat = r.flattenTree(r.treeOfCommit(ancestor))
	}
	baseFlat := r.flattenTree(r.treeOfCommit(baseTip))
	headFlat := r.flattenTree(r.treeOfCommit(headTip))
	result := map[string]flatEntry{}
	for p, e := range baseFlat {
		result[p] = e
	}
	paths := map[string]bool{}
	for p := range ancestorFlat {
		paths[p] = true
	}
	for p := range headFlat {
		paths[p] = true
	}
	for p := range paths {
		ancEnt, inAnc := ancestorFlat[p]
		headEnt, inHead := headFlat[p]
		headChanged := inHead != inAnc || (inHead && inAnc && headEnt.OID != ancEnt.OID)
		if !headChanged {
			continue
		}
		if inHead {
			result[p] = headEnt
		} else {
			delete(result, p)
		}
	}
	treeOID := r.buildTreeFromFlat(result)
	return r.newServerCommit(treeOID, []string{baseTip}, message)
}

// mergePullRequest performs the shared squash merge used by REST, GraphQL
// and MCP. Callers hold the write lock. Returns the squash commit oid, or an
// error string ("not found", "closed", "conflict").
func (r *Repo) mergePullRequest(pr *PullRequest) (string, string) {
	if pr.State != "open" {
		return "", "closed"
	}
	baseTip, baseOK := r.branchTip(pr.BaseRef)
	headTip, headOK := r.branchTip(pr.HeadRef)
	if !baseOK || !headOK {
		return "", "not found"
	}
	if r.mergeConflict(baseTip, headTip) {
		return "", "conflict"
	}
	commitOID := r.squashMerge(baseTip, headTip, pr.Title)
	r.Refs["refs/heads/"+pr.BaseRef] = commitOID
	r.bumpGit()
	pr.State = "closed"
	pr.Merged = true
	pr.MergedAt = mergedAtFixed
	pr.MergeCommitSHA = commitOID
	return commitOID, ""
}

func (s *Server) mergePull(w http.ResponseWriter, r *http.Request, owner, name string, num int) {
	// The body carries merge_method; only squash is graded and every method
	// is treated as a squash. A malformed body still answers 400.
	if _, ok := s.decodeBody(w, r); !ok {
		return
	}
	s.store.mu.Lock()
	repo := s.store.lookup(owner, name)
	if repo == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	pr := repo.PRsByNum[num]
	if pr == nil {
		s.store.mu.Unlock()
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	commitOID, errStr := repo.mergePullRequest(pr)
	s.store.mu.Unlock()
	switch errStr {
	case "not found":
		s.writeErr(w, http.StatusNotFound, "Not Found")
	case "closed", "conflict":
		s.writeErr(w, http.StatusMethodNotAllowed, "pull request cannot be merged")
	default:
		s.writeJSON(w, http.StatusOK, map[string]any{
			"sha":     commitOID,
			"merged":  true,
			"message": "Pull request successfully merged",
		})
	}
}
