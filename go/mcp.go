// MCP: JSON-RPC 2.0 over Streamable HTTP (plain JSON responses). The modern
// server/discover era plus the legacy initialize fallback, six tools, and the
// error shapes the suite asserts.

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

const mcpServerName = "github-core-clone"
const mcpServerVersion = "1.0.0"
const mcpProtocolVersion = "2026-07-28"

// --- JSON-RPC envelopes ---

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func (r *rpcRequest) hasID() bool {
	if len(r.ID) == 0 {
		return false
	}
	trimmed := bytes.TrimSpace(r.ID)
	return len(trimmed) > 0 && string(trimmed) != "null"
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func rpcResult(id json.RawMessage, result any) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func rpcFailure(id json.RawMessage, code int, message string) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message}}
}

// --- tool definitions (fixed order, deterministic marshaling) ---

type mcpProperty struct {
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

type mcpInputSchema struct {
	Type       string                 `json:"type"`
	Properties map[string]mcpProperty `json:"properties"`
	Required   []string               `json:"required"`
}

type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema mcpInputSchema `json:"inputSchema"`
}

func strProp(desc string) mcpProperty  { return mcpProperty{Type: "string", Description: desc} }
func boolProp(desc string) mcpProperty { return mcpProperty{Type: "boolean", Description: desc} }
func intProp(desc string) mcpProperty  { return mcpProperty{Type: "integer", Description: desc} }

func mcpTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "create_repo",
			Description: "Create a repository owned by the authenticated user.",
			InputSchema: mcpInputSchema{
				Type: "object",
				Properties: map[string]mcpProperty{
					"name":        strProp("The repository name."),
					"description": strProp("The repository description."),
					"private":     boolProp("Whether the repository is private."),
					"owner":       strProp("Ignored; repositories are created under the authenticated user."),
				},
				Required: []string{"name"},
			},
		},
		{
			Name:        "get_repo",
			Description: "Get a repository by owner and name.",
			InputSchema: mcpInputSchema{
				Type: "object",
				Properties: map[string]mcpProperty{
					"owner": strProp("The repository owner."),
					"repo":  strProp("The repository name."),
				},
				Required: []string{"owner", "repo"},
			},
		},
		{
			Name:        "create_issue",
			Description: "Create an issue in a repository.",
			InputSchema: mcpInputSchema{
				Type: "object",
				Properties: map[string]mcpProperty{
					"owner": strProp("The repository owner."),
					"repo":  strProp("The repository name."),
					"title": strProp("The issue title."),
					"body":  strProp("The issue body."),
				},
				Required: []string{"owner", "repo", "title"},
			},
		},
		{
			Name:        "list_issues",
			Description: "List issues in a repository, optionally filtered by state.",
			InputSchema: mcpInputSchema{
				Type: "object",
				Properties: map[string]mcpProperty{
					"owner": strProp("The repository owner."),
					"repo":  strProp("The repository name."),
					"state": strProp("Filter by state: open, closed, or all."),
				},
				Required: []string{"owner", "repo"},
			},
		},
		{
			Name:        "create_pull_request",
			Description: "Create a pull request in a repository.",
			InputSchema: mcpInputSchema{
				Type: "object",
				Properties: map[string]mcpProperty{
					"owner": strProp("The repository owner."),
					"repo":  strProp("The repository name."),
					"title": strProp("The pull request title."),
					"head":  strProp("The head branch name."),
					"base":  strProp("The base branch name."),
					"body":  strProp("The pull request body."),
				},
				Required: []string{"owner", "repo", "title", "head", "base"},
			},
		},
		{
			Name:        "merge_pull_request",
			Description: "Merge a pull request with a squash commit.",
			InputSchema: mcpInputSchema{
				Type: "object",
				Properties: map[string]mcpProperty{
					"owner":       strProp("The repository owner."),
					"repo":        strProp("The repository name."),
					"pull_number": intProp("The pull request number."),
				},
				Required: []string{"owner", "repo", "pull_number"},
			},
		},
	}
}

// --- tool results ---

type mcpTextContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type mcpToolResult struct {
	Content           []mcpTextContent `json:"content"`
	StructuredContent any              `json:"structuredContent"`
	IsError           bool             `json:"isError,omitempty"`
}

func mcpSuccess(value any) mcpToolResult {
	text, _ := json.Marshal(value)
	return mcpToolResult{
		Content:           []mcpTextContent{{Type: "text", Text: string(text)}},
		StructuredContent: value,
	}
}

func mcpToolError(message string) mcpToolResult {
	return mcpToolResult{
		Content:           []mcpTextContent{{Type: "text", Text: message}},
		StructuredContent: map[string]string{"error": message},
		IsError:           true,
	}
}

// --- argument helpers ---

func mcpArgString(args jobj, name string) (string, bool) {
	return args.str(name)
}

// mcpArgInt accepts a JSON number or a digit string.
func mcpArgInt(args jobj, name string) (int, bool) {
	if raw, ok := args[name]; ok {
		var n json.Number
		if err := json.Unmarshal(raw, &n); err == nil {
			if i, err := n.Int64(); err == nil {
				return int(i), true
			}
			if f, err := strconv.ParseFloat(n.String(), 64); err == nil {
				return int(f), true
			}
		}
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			if i, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
				return i, true
			}
		}
	}
	return 0, false
}

// --- handler ---

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if !s.authed(r) {
		s.writeErr(w, http.StatusUnauthorized, "Requires authentication")
		return
	}
	body := readBody(r)
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		s.writeMCPParseError(w)
		return
	}
	if trimmed[0] == '[' {
		var rawList []json.RawMessage
		if err := json.Unmarshal(trimmed, &rawList); err != nil {
			s.writeMCPParseError(w)
			return
		}
		var responses []rpcResponse
		for _, raw := range rawList {
			var req rpcRequest
			if err := json.Unmarshal(raw, &req); err != nil {
				responses = append(responses, rpcFailure(json.RawMessage("null"), -32700, "Parse error"))
				continue
			}
			if resp, ok := s.dispatchMCP(&req); ok {
				responses = append(responses, resp)
			}
		}
		if len(responses) == 0 {
			s.writeMCPEmpty(w)
			return
		}
		s.writeJSON(w, http.StatusOK, responses)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(trimmed, &req); err != nil {
		s.writeMCPParseError(w)
		return
	}
	resp, ok := s.dispatchMCP(&req)
	if !ok {
		s.writeMCPEmpty(w)
		return
	}
	s.writeJSON(w, http.StatusOK, resp)
}

func (s *Server) writeMCPParseError(w http.ResponseWriter) {
	body, _ := json.Marshal(rpcFailure(json.RawMessage("null"), -32700, "Parse error"))
	s.writeJSONBytes(w, http.StatusBadRequest, body)
}

// writeMCPEmpty answers a notification: HTTP 202 with an empty body.
func (s *Server) writeMCPEmpty(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-GitHub-Request-Id", s.store.nextRequestID())
	h.Set("Content-Length", "0")
	w.WriteHeader(http.StatusAccepted)
}

// dispatchMCP executes one JSON-RPC request. The second result is false for
// notifications, which carry no response.
func (s *Server) dispatchMCP(req *rpcRequest) (rpcResponse, bool) {
	if !req.hasID() {
		return rpcResponse{}, false
	}
	id := req.ID
	switch req.Method {
	case "server/discover":
		serverInfo := map[string]string{"name": mcpServerName, "version": mcpServerVersion}
		return rpcResult(id, map[string]any{
			"supportedVersions": []string{mcpProtocolVersion},
			"capabilities":      map[string]any{"tools": map[string]any{}},
			"serverInfo":        serverInfo,
			"_meta": map[string]any{
				"io.modelcontextprotocol/serverInfo": serverInfo,
			},
		}), true
	case "initialize":
		version := mcpProtocolVersion
		if params, ok := parseBody(req.Params); ok {
			if v, present := params.str("protocolVersion"); present && v != "" {
				version = v
			}
		}
		return rpcResult(id, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]string{"name": mcpServerName, "version": mcpServerVersion},
		}), true
	case "ping":
		return rpcResult(id, map[string]any{}), true
	case "tools/list":
		return rpcResult(id, map[string]any{"tools": mcpTools()}), true
	case "tools/call":
		return s.mcpToolsCall(id, req.Params)
	default:
		return rpcFailure(id, -32601, "Method not found: "+req.Method), true
	}
}

func (s *Server) mcpToolsCall(id json.RawMessage, rawParams json.RawMessage) (rpcResponse, bool) {
	params, ok := parseBody(rawParams)
	if !ok {
		return rpcFailure(id, -32602, "Invalid params"), true
	}
	name, _ := params.str("name")
	args := jobj{}
	if rawArgs, present := params["arguments"]; present {
		parsed, ok := parseBody(rawArgs)
		if !ok {
			return rpcFailure(id, -32602, "arguments must be an object"), true
		}
		args = parsed
	}
	switch name {
	case "create_repo", "get_repo", "create_issue", "list_issues", "create_pull_request", "merge_pull_request":
	default:
		return rpcFailure(id, -32602, "Unknown tool: "+name), true
	}
	result, rpcErr := s.executeMCPTool(name, args)
	if rpcErr != "" {
		return rpcFailure(id, -32602, rpcErr), true
	}
	return rpcResult(id, result), true
}

// executeMCPTool runs one tool. A non-empty second result is a JSON-RPC
// -32602 invalid-params error; domain failures come back as isError results.
func (s *Server) executeMCPTool(name string, args jobj) (mcpToolResult, string) {
	require := func(key string) (string, bool) {
		v, ok := mcpArgString(args, key)
		return v, ok && strings.TrimSpace(v) != ""
	}
	switch name {
	case "get_repo", "list_issues":
		// Read-only tools take the read lock.
		owner, okOwner := require("owner")
		repoName, okRepo := require("repo")
		if !okOwner || !okRepo {
			return mcpToolResult{}, "owner and repo are required"
		}
		s.store.mu.RLock()
		defer s.store.mu.RUnlock()
		repo := s.store.lookup(owner, repoName)
		if repo == nil {
			return mcpToolError("repository not found: " + owner + "/" + repoName), ""
		}
		if name == "get_repo" {
			return mcpSuccess(repoView(repo)), ""
		}
		state, _ := mcpArgString(args, "state")
		if state == "" {
			state = "open"
		}
		issues := make([]issueJSON, 0)
		for _, issue := range repo.Issues {
			if state != "all" && issue.State != state {
				continue
			}
			issues = append(issues, issueView(issue))
		}
		return mcpSuccess(issues), ""
	}

	// Mutating tools take the write lock.
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	switch name {
	case "create_repo":
		repoName, ok := require("name")
		if !ok {
			return mcpToolResult{}, "name is required"
		}
		description, _ := mcpArgString(args, "description")
		private, _ := args.boolean("private")
		repo := s.store.createRepo(repoName, description, private)
		if repo == nil {
			return mcpToolError("repository already exists: " + repoName), ""
		}
		return mcpSuccess(repoView(repo)), ""
	case "create_issue":
		owner, okOwner := require("owner")
		repoName, okRepo := require("repo")
		title, okTitle := require("title")
		if !okOwner || !okRepo || !okTitle {
			return mcpToolResult{}, "owner, repo and title are required"
		}
		body, _ := mcpArgString(args, "body")
		repo := s.store.lookup(owner, repoName)
		if repo == nil {
			return mcpToolError("repository not found: " + owner + "/" + repoName), ""
		}
		issue := &Issue{
			ID:     s.store.nextID,
			Number: repo.NextIssue,
			Title:  title,
			Body:   body,
			State:  "open",
			Labels: []string{},
		}
		s.store.nextID++
		repo.NextIssue++
		repo.Issues = append(repo.Issues, issue)
		repo.IssuesByNum[issue.Number] = issue
		s.cacheIssueJSON(repo, issue)
		return mcpSuccess(issueView(issue)), ""
	case "create_pull_request":
		owner, okOwner := require("owner")
		repoName, okRepo := require("repo")
		title, okTitle := require("title")
		head, okHead := require("head")
		base, okBase := require("base")
		if !okOwner || !okRepo || !okTitle || !okHead || !okBase {
			return mcpToolResult{}, "owner, repo, title, head and base are required"
		}
		body, _ := mcpArgString(args, "body")
		repo := s.store.lookup(owner, repoName)
		if repo == nil {
			return mcpToolError("repository not found: " + owner + "/" + repoName), ""
		}
		headSHA, headOK := repo.branchTip(stripOwnerPrefix(head))
		baseSHA, baseOK := repo.branchTip(stripOwnerPrefix(base))
		if !headOK || !baseOK {
			return mcpToolError("head or base branch does not exist"), ""
		}
		pr := &PullRequest{
			ID:      s.store.nextID,
			Number:  repo.NextPR,
			Title:   title,
			Body:    body,
			State:   "open",
			HeadRef: stripOwnerPrefix(head),
			HeadSHA: headSHA,
			BaseRef: stripOwnerPrefix(base),
			BaseSHA: baseSHA,
		}
		s.store.nextID++
		repo.NextPR++
		repo.PRs = append(repo.PRs, pr)
		repo.PRsByNum[pr.Number] = pr
		return mcpSuccess(prView(repo, pr)), ""
	case "merge_pull_request":
		owner, okOwner := require("owner")
		repoName, okRepo := require("repo")
		number, okNum := mcpArgInt(args, "pull_number")
		if !okOwner || !okRepo || !okNum {
			return mcpToolResult{}, "owner, repo and pull_number are required"
		}
		repo := s.store.lookup(owner, repoName)
		if repo == nil {
			return mcpToolError("repository not found: " + owner + "/" + repoName), ""
		}
		pr := repo.PRsByNum[number]
		if pr == nil {
			return mcpToolError("pull request not found"), ""
		}
		if _, errStr := repo.mergePullRequest(pr); errStr != "" {
			return mcpToolError("pull request cannot be merged: " + errStr), ""
		}
		return mcpSuccess(prView(repo, pr)), ""
	}
	return mcpToolResult{}, "unknown tool"
}
