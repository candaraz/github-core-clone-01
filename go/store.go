// The in-memory store: every surface (git, REST, GraphQL, MCP) reads and
// writes this one model, so the surfaces can never disagree.
//
// Concurrency: one global RWMutex guards the whole store. Reads take RLock
// (shared, so the 50 concurrent clones run in parallel); writes take Lock.
// The benchmark phases never mix concurrent reads and writes on purpose, so a
// single lock costs nothing measurable and removes all lock-ordering risk.

package main

import (
	"encoding/base64"
	"strconv"
	"sync"
	"sync/atomic"
)

// The token owner's identity, from the published fixed scenario (wire.ts
// SCENARIO_SEED is constant, so these never vary between trials).
const (
	viewerLogin = "adaiversen"
	viewerID    = 1000
	viewerName  = "ada iversen"
	viewerEmail = "adaiversen@example.invalid"
)

// Fixed commit identity/timestamps for server-created commits. The timestamp
// advances by one second per server commit within a repo (a monotonic counter
// rooted at a fixed epoch), so repeated runs of the same request sequence emit
// identical bytes while distinct operations never collide on an object id.
const (
	commitEpochSec = 1700000000
	commitIdent    = "ada iversen <adaiversen@example.invalid>"
	mergedAtFixed  = "2023-11-14T22:13:20Z"
)

// A git object: its type and its exact bytes (no header; the id is the SHA-1
// over "<type> <size>\0" + bytes).
type Object struct {
	Type string // commit, tree, blob, tag
	Data []byte
}

// A parsed commit, cached at store time so ancestry walks never re-parse.
type CommitInfo struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

// One tree entry, as stored: "<mode> <name>\0<20-byte oid>".
type TreeEntry struct {
	Mode string
	Name string
	OID  string
}

type Label struct {
	Name  string
	Color string
}

type Comment struct {
	ID   int64
	Body string
}

type Issue struct {
	ID       int64
	Number   int
	Title    string
	Body     string
	State    string // open, closed
	Labels   []string
	Comments []*Comment
}

type PullRequest struct {
	ID             int64
	Number         int
	Title          string
	Body           string
	State          string // open, closed
	HeadRef        string
	HeadSHA        string // frozen at creation
	BaseRef        string
	BaseSHA        string // frozen at creation
	Merged         bool
	MergedAt       string // "" until merged
	MergeCommitSHA string // "" until merged
}

// A repository: objects, refs, issues, pull requests, labels, and the
// version-keyed response caches. All fields are guarded by Store.mu.
type Repo struct {
	ID            int64
	Owner         string
	Name          string
	Description   string
	Private       bool
	DefaultBranch string

	Objects     map[string]*Object
	CommitCache map[string]*CommitInfo
	TreeCache   map[string][]TreeEntry
	Refs        map[string]string // full ref name -> oid

	Labels     map[string]*Label
	LabelOrder []string

	Issues      []*Issue
	IssuesByNum map[int]*Issue
	NextIssue   int
	PRs         []*PullRequest
	PRsByNum    map[int]*PullRequest
	NextPR      int

	CommitSeq uint64 // server-commit timestamp counter

	// Version-keyed caches. Bump version (and drop the git caches) on every
	// change to objects or refs; drop issue JSON on issue/label changes.
	Version    uint64
	lsCache    map[string][]byte
	fetchCache map[string][]byte
	issueJSON  map[int][]byte
}

// bumpGit invalidates every cache that depends on objects or refs.
func (r *Repo) bumpGit() {
	r.Version++
	r.lsCache = nil
	r.fetchCache = nil
}

func (r *Repo) ref(name string) (string, bool) {
	oid, ok := r.Refs[name]
	return oid, ok
}

func (r *Repo) branchTip(branch string) (string, bool) {
	return r.ref("refs/heads/" + branch)
}

// Store is the whole forge state.
type Store struct {
	mu       sync.RWMutex
	repos    map[string]*Repo // owner + "\x00" + name
	byID     map[int64]*Repo
	order    []*Repo // creation order, for GET /user/repos
	nextRepo int64   // repository database ids, from 5000 like the scenario
	nextID   int64   // REST ids for issues, comments and pull requests
	reqSeq   atomic.Uint64
}

func NewStore() *Store {
	return &Store{
		repos:    make(map[string]*Repo),
		byID:     make(map[int64]*Repo),
		nextRepo: 5000,
		nextID:   1,
	}
}

func repoKey(owner, name string) string { return owner + "\x00" + name }

// nextRequestID returns a fresh non-empty request id. It uses its own atomic
// counter so it can be called while Store.mu is held.
func (s *Store) nextRequestID() string {
	return "req-" + strconv.FormatUint(s.reqSeq.Add(1), 10)
}

// lookup returns a repo by owner/name. Callers hold s.mu (read or write).
func (s *Store) lookup(owner, name string) *Repo {
	return s.repos[repoKey(owner, name)]
}

// createRepo adds a repository owned by the viewer. Callers hold s.mu (write).
// Returns nil when a repo of that name already exists.
func (s *Store) createRepo(name, description string, private bool) *Repo {
	key := repoKey(viewerLogin, name)
	if _, exists := s.repos[key]; exists {
		return nil
	}
	r := &Repo{
		ID:            s.nextRepo,
		Owner:         viewerLogin,
		Name:          name,
		Description:   description,
		Private:       private,
		DefaultBranch: "main",
		Objects:       make(map[string]*Object),
		CommitCache:   make(map[string]*CommitInfo),
		TreeCache:     make(map[string][]TreeEntry),
		Refs:          make(map[string]string),
		Labels:        make(map[string]*Label),
		IssuesByNum:   make(map[int]*Issue),
		NextIssue:     1,
		PRsByNum:      make(map[int]*PullRequest),
		NextPR:        1,
		issueJSON:     make(map[int][]byte),
	}
	s.nextRepo++
	s.repos[key] = r
	s.byID[r.ID] = r
	s.order = append(s.order, r)
	return r
}

// deleteRepo removes a repository entirely. Callers hold s.mu (write).
func (s *Store) deleteRepo(r *Repo) {
	key := repoKey(r.Owner, r.Name)
	delete(s.repos, key)
	delete(s.byID, r.ID)
	for i, cand := range s.order {
		if cand == r {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

// --- Opaque global (Relay) ids: base64 of a typed string. Stable across reads,
// never equal to the plain numeric id, decodable for mutations and node(). ---

func encodeGlobalID(kind string, parts ...int64) string {
	text := kind
	for _, p := range parts {
		text += ":" + strconv.FormatInt(p, 10)
	}
	return base64.StdEncoding.EncodeToString([]byte(text))
}

func decodeGlobalID(id string) (kind string, parts []int64, ok bool) {
	raw, err := base64.StdEncoding.DecodeString(id)
	if err != nil {
		return "", nil, false
	}
	text := string(raw)
	// Split on ':'; the kind is the first field, the rest are integers.
	fields := splitColon(text)
	if len(fields) < 2 {
		return "", nil, false
	}
	kind = fields[0]
	for _, f := range fields[1:] {
		n, err := strconv.ParseInt(f, 10, 64)
		if err != nil {
			return "", nil, false
		}
		parts = append(parts, n)
	}
	return kind, parts, true
}

func splitColon(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

func repoGlobalID(r *Repo) string { return encodeGlobalID("Repository", r.ID) }
func issueGlobalID(r *Repo, n int) string {
	return encodeGlobalID("Issue", r.ID, int64(n))
}
func prGlobalID(r *Repo, n int) string {
	return encodeGlobalID("PullRequest", r.ID, int64(n))
}
func commentGlobalID(r *Repo, issueNum int, commentID int64) string {
	return encodeGlobalID("IssueComment", r.ID, int64(issueNum), commentID)
}
