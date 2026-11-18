// JSON helpers: lenient request-body parsing and the response shapes shared
// by the REST, GraphQL and MCP surfaces. Every list field is built non-nil so
// it marshals as [] rather than null.

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// jobj is a decoded JSON object with typed getters that report presence, so
// PATCH handlers can tell "absent" from "explicitly empty".
type jobj map[string]json.RawMessage

// parseBody decodes a request body. An empty body or JSON null decodes to an
// empty object; invalid JSON or a non-object value reports malformed.
func parseBody(body []byte) (jobj, bool) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return jobj{}, true
	}
	var raw json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	if err := dec.Decode(&raw); err != nil {
		return nil, false
	}
	if string(raw) == "null" {
		return jobj{}, true
	}
	var obj jobj
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, false
	}
	if obj == nil {
		obj = jobj{}
	}
	return obj, true
}

func (o jobj) has(key string) bool {
	_, ok := o[key]
	return ok
}

func (o jobj) str(key string) (string, bool) {
	raw, ok := o[key]
	if !ok {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

func (o jobj) boolean(key string) (bool, bool) {
	raw, ok := o[key]
	if !ok {
		return false, false
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		return false, false
	}
	return b, true
}

func (o jobj) strSlice(key string) ([]string, bool) {
	raw, ok := o[key]
	if !ok {
		return nil, false
	}
	var arr []string
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, false
	}
	if arr == nil {
		arr = []string{}
	}
	return arr, true
}

func (o jobj) integer(key string) (int64, bool) {
	raw, ok := o[key]
	if !ok {
		return 0, false
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, false
	}
	i, err := n.Int64()
	if err != nil {
		// Accept 12.0-style numbers.
		f, ferr := strconv.ParseFloat(n.String(), 64)
		if ferr != nil {
			return 0, false
		}
		return int64(f), true
	}
	return i, true
}

// --- response shapes ---

type userJSON struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
	Name  string `json:"name,omitempty"`
	Email string `json:"email,omitempty"`
}

func viewerJSON() userJSON {
	return userJSON{Login: viewerLogin, ID: viewerID, Name: viewerName, Email: viewerEmail}
}

type repoJSON struct {
	ID            int64    `json:"id"`
	Name          string   `json:"name"`
	FullName      string   `json:"full_name"`
	Private       bool     `json:"private"`
	Description   string   `json:"description"`
	DefaultBranch string   `json:"default_branch"`
	Owner         userJSON `json:"owner"`
}

func repoView(r *Repo) repoJSON {
	return repoJSON{
		ID:            r.ID,
		Name:          r.Name,
		FullName:      r.Owner + "/" + r.Name,
		Private:       r.Private,
		Description:   r.Description,
		DefaultBranch: r.DefaultBranch,
		Owner:         viewerJSON(),
	}
}

type labelJSON struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func labelView(l *Label) labelJSON { return labelJSON{Name: l.Name, Color: l.Color} }

type issueJSON struct {
	ID     int64       `json:"id"`
	Number int         `json:"number"`
	Title  string      `json:"title"`
	Body   string      `json:"body"`
	State  string      `json:"state"`
	Labels []labelJSON `json:"labels"`
	User   userJSON    `json:"user"`
}

func issueView(issue *Issue) issueJSON {
	labels := make([]labelJSON, 0, len(issue.Labels))
	for _, name := range issue.Labels {
		labels = append(labels, labelJSON{Name: name})
	}
	return issueJSON{
		ID:     issue.ID,
		Number: issue.Number,
		Title:  issue.Title,
		Body:   issue.Body,
		State:  issue.State,
		Labels: labels,
		User:   viewerJSON(),
	}
}

type prRefJSON struct {
	Ref   string `json:"ref"`
	SHA   string `json:"sha"`
	Label string `json:"label"`
}

type prJSON struct {
	ID             int64     `json:"id"`
	Number         int       `json:"number"`
	Title          string    `json:"title"`
	Body           string    `json:"body"`
	State          string    `json:"state"`
	Head           prRefJSON `json:"head"`
	Base           prRefJSON `json:"base"`
	Merged         bool      `json:"merged"`
	MergedAt       *string   `json:"merged_at"`
	MergeCommitSHA *string   `json:"merge_commit_sha"`
	User           userJSON  `json:"user"`
}

func prView(r *Repo, pr *PullRequest) prJSON {
	var mergedAt, mergeSHA *string
	if pr.Merged {
		mergedAt = &pr.MergedAt
		mergeSHA = &pr.MergeCommitSHA
	}
	return prJSON{
		ID:     pr.ID,
		Number: pr.Number,
		Title:  pr.Title,
		Body:   pr.Body,
		State:  pr.State,
		Head: prRefJSON{
			Ref:   pr.HeadRef,
			SHA:   pr.HeadSHA,
			Label: r.Owner + ":" + pr.HeadRef,
		},
		Base: prRefJSON{
			Ref:   pr.BaseRef,
			SHA:   pr.BaseSHA,
			Label: r.Owner + ":" + pr.BaseRef,
		},
		Merged:         pr.Merged,
		MergedAt:       mergedAt,
		MergeCommitSHA: mergeSHA,
		User:           viewerJSON(),
	}
}

type commentJSON struct {
	ID   int64    `json:"id"`
	Body string   `json:"body"`
	User userJSON `json:"user"`
}

func commentView(c *Comment) commentJSON {
	return commentJSON{ID: c.ID, Body: c.Body, User: viewerJSON()}
}

// --- response writers (used by every surface) ---

// writeJSONBytes sends prebuilt JSON with the standard headers.
func (s *Server) writeJSONBytes(w http.ResponseWriter, status int, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("X-GitHub-Request-Id", s.store.nextRequestID())
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	w.Write(body)
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		s.writeErr(w, http.StatusInternalServerError, "failed to encode response")
		return
	}
	s.writeJSONBytes(w, status, body)
}

func (s *Server) writeErr(w http.ResponseWriter, status int, message string) {
	s.writeJSON(w, status, map[string]string{"message": message})
}

func (s *Server) writeNoContent(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-GitHub-Request-Id", s.store.nextRequestID())
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", "0")
	w.WriteHeader(http.StatusNoContent)
}

// --- pagination ---

// pageParams reads page/per_page with GitHub-like defaults.
func pageParams(r *http.Request) (page, perPage int) {
	page, perPage = 1, 30
	q := r.URL.Query()
	if v := q.Get("page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			page = n
		}
	}
	if v := q.Get("per_page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			perPage = n
		}
	}
	return page, perPage
}

// paginate slices a list and, when a next page exists, emits the Link header
// with an absolute same-origin URL.
func paginate[T any](w http.ResponseWriter, r *http.Request, items []T) []T {
	page, perPage := pageParams(r)
	start := (page - 1) * perPage
	if start >= len(items) {
		return []T{}
	}
	end := start + perPage
	hasNext := false
	if end < len(items) {
		hasNext = true
	} else {
		end = len(items)
	}
	if hasNext {
		q := r.URL.Query()
		q.Set("page", strconv.Itoa(page+1))
		q.Set("per_page", strconv.Itoa(perPage))
		next := "http://" + r.Host + r.URL.Path + "?" + q.Encode()
		w.Header().Set("Link", "<"+next+">; rel=\"next\"")
	}
	return items[start:end]
}

// splitPath splits a URL path into non-empty segments.
func splitPath(path string) []string {
	var out []string
	for _, seg := range strings.Split(path, "/") {
		if seg != "" {
			out = append(out, seg)
		}
	}
	return out
}
