// GraphQL: a small lexer, parser, validator and executor for the fixed set
// of documents the suite sends (gh-shaped queries and mutations). The schema
// surface is exactly the one the kit's header comment documents.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type gqlTokenKind int

const (
	tokEOF gqlTokenKind = iota
	tokName
	tokInt
	tokFloat
	tokString
	tokLBrace
	tokRBrace
	tokLParen
	tokRParen
	tokLBracket
	tokRBracket
	tokColon
	tokEquals
	tokBang
	tokDollar
	tokSpread
	tokAt
	tokPipe
	tokAmp
)

type gqlToken struct {
	kind gqlTokenKind
	text string
}

func gqlLex(src string) ([]gqlToken, error) {
	var tokens []gqlToken
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',':
			i++
		case c == '#':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '{':
			tokens = append(tokens, gqlToken{tokLBrace, "{"})
			i++
		case c == '}':
			tokens = append(tokens, gqlToken{tokRBrace, "}"})
			i++
		case c == '(':
			tokens = append(tokens, gqlToken{tokLParen, "("})
			i++
		case c == ')':
			tokens = append(tokens, gqlToken{tokRParen, ")"})
			i++
		case c == '[':
			tokens = append(tokens, gqlToken{tokLBracket, "["})
			i++
		case c == ']':
			tokens = append(tokens, gqlToken{tokRBracket, "]"})
			i++
		case c == ':':
			tokens = append(tokens, gqlToken{tokColon, ":"})
			i++
		case c == '=':
			tokens = append(tokens, gqlToken{tokEquals, "="})
			i++
		case c == '!':
			tokens = append(tokens, gqlToken{tokBang, "!"})
			i++
		case c == '$':
			tokens = append(tokens, gqlToken{tokDollar, "$"})
			i++
		case c == '@':
			tokens = append(tokens, gqlToken{tokAt, "@"})
			i++
		case c == '|':
			tokens = append(tokens, gqlToken{tokPipe, "|"})
			i++
		case c == '&':
			tokens = append(tokens, gqlToken{tokAmp, "&"})
			i++
		case c == '.' && i+2 < len(src) && src[i+1] == '.' && src[i+2] == '.':
			tokens = append(tokens, gqlToken{tokSpread, "..."})
			i += 3
		case c == '"':
			if i+2 < len(src) && src[i+1] == '"' && src[i+2] == '"' {
				// Block string: scan to the closing """.
				end := strings.Index(src[i+3:], `"""`)
				if end < 0 {
					return nil, fmt.Errorf("unterminated block string")
				}
				tokens = append(tokens, gqlToken{tokString, src[i+3 : i+3+end]})
				i += 3 + end + 3
			} else {
				value, next, err := gqlLexString(src, i)
				if err != nil {
					return nil, err
				}
				tokens = append(tokens, gqlToken{tokString, value})
				i = next
			}
		case c == '-' || (c >= '0' && c <= '9'):
			start := i
			if c == '-' {
				i++
			}
			isFloat := false
			for i < len(src) && src[i] >= '0' && src[i] <= '9' {
				i++
			}
			if i < len(src) && src[i] == '.' {
				isFloat = true
				i++
				for i < len(src) && src[i] >= '0' && src[i] <= '9' {
					i++
				}
			}
			if i < len(src) && (src[i] == 'e' || src[i] == 'E') {
				isFloat = true
				i++
				if i < len(src) && (src[i] == '+' || src[i] == '-') {
					i++
				}
				for i < len(src) && src[i] >= '0' && src[i] <= '9' {
					i++
				}
			}
			kind := tokInt
			if isFloat {
				kind = tokFloat
			}
			tokens = append(tokens, gqlToken{kind, src[start:i]})
		case c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'):
			start := i
			for i < len(src) && (src[i] == '_' || src[i] >= 'A' && src[i] <= 'Z' || src[i] >= 'a' && src[i] <= 'z' || src[i] >= '0' && src[i] <= '9') {
				i++
			}
			tokens = append(tokens, gqlToken{tokName, src[start:i]})
		default:
			return nil, fmt.Errorf("unexpected character %q in GraphQL document", c)
		}
	}
	tokens = append(tokens, gqlToken{tokEOF, ""})
	return tokens, nil
}

func gqlLexString(src string, start int) (string, int, error) {
	var sb strings.Builder
	i := start + 1
	for i < len(src) {
		c := src[i]
		if c == '"' {
			return sb.String(), i + 1, nil
		}
		if c == '\n' {
			return "", 0, fmt.Errorf("unterminated string in GraphQL document")
		}
		if c == '\\' {
			if i+1 >= len(src) {
				return "", 0, fmt.Errorf("unterminated escape in GraphQL string")
			}
			esc := src[i+1]
			switch esc {
			case '"':
				sb.WriteByte('"')
				i += 2
			case '\\':
				sb.WriteByte('\\')
				i += 2
			case '/':
				sb.WriteByte('/')
				i += 2
			case 'b':
				sb.WriteByte('\b')
				i += 2
			case 'f':
				sb.WriteByte('\f')
				i += 2
			case 'n':
				sb.WriteByte('\n')
				i += 2
			case 'r':
				sb.WriteByte('\r')
				i += 2
			case 't':
				sb.WriteByte('\t')
				i += 2
			case 'u':
				if i+5 >= len(src) {
					return "", 0, fmt.Errorf("truncated unicode escape in GraphQL string")
				}
				n, err := strconv.ParseUint(src[i+2:i+6], 16, 32)
				if err != nil {
					return "", 0, fmt.Errorf("invalid unicode escape in GraphQL string")
				}
				sb.WriteRune(rune(n))
				i += 6
			default:
				return "", 0, fmt.Errorf("invalid escape %q in GraphQL string", esc)
			}
			continue
		}
		sb.WriteByte(c)
		i++
	}
	return "", 0, fmt.Errorf("unterminated string in GraphQL document")
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type gqlValueKind int

const (
	gqlVar gqlValueKind = iota
	gqlIntVal
	gqlFloatVal
	gqlStringVal
	gqlBoolVal
	gqlNullVal
	gqlEnumVal
	gqlListVal
	gqlObjectVal
)

type gqlValue struct {
	kind    gqlValueKind
	str     string
	boolean bool
	list    []gqlValue
	object  map[string]gqlValue
}

type gqlField struct {
	alias     string
	name      string
	args      map[string]gqlValue
	selection *gqlSelectionSet
}

type gqlInlineFragment struct {
	typeCond  string
	selection *gqlSelectionSet
}

type gqlFragmentSpread struct {
	name string
}

type gqlSelection struct {
	field    *gqlField
	fragment *gqlInlineFragment
	spread   *gqlFragmentSpread
}

type gqlSelectionSet struct {
	selections []gqlSelection
}

type gqlVarDef struct {
	name       string
	hasDefault bool
	defValue   gqlValue
}

type gqlOperation struct {
	kind      string // query or mutation
	name      string
	varDefs   []gqlVarDef
	selection *gqlSelectionSet
}

type gqlFragment struct {
	name      string
	typeCond  string
	selection *gqlSelectionSet
}

type gqlDocument struct {
	operations []*gqlOperation
	fragments  map[string]*gqlFragment
}

type gqlParser struct {
	tokens []gqlToken
	pos    int
}

func (p *gqlParser) peek() gqlToken { return p.tokens[p.pos] }
func (p *gqlParser) next() gqlToken { t := p.tokens[p.pos]; p.pos++; return t }

func (p *gqlParser) expect(kind gqlTokenKind) (gqlToken, error) {
	t := p.next()
	if t.kind != kind {
		return t, fmt.Errorf("expected %v, found %q", kind, t.text)
	}
	return t, nil
}

func (p *gqlParser) expectName(want string) error {
	t := p.next()
	if t.kind != tokName || t.text != want {
		return fmt.Errorf("expected %q, found %q", want, t.text)
	}
	return nil
}

func gqlParse(src string) (*gqlDocument, error) {
	tokens, err := gqlLex(src)
	if err != nil {
		return nil, err
	}
	p := &gqlParser{tokens: tokens}
	doc := &gqlDocument{fragments: map[string]*gqlFragment{}}
	for p.peek().kind != tokEOF {
		if p.peek().kind == tokLBrace {
			sel, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			doc.operations = append(doc.operations, &gqlOperation{kind: "query", selection: sel})
			continue
		}
		kw := p.next()
		if kw.kind != tokName {
			return nil, fmt.Errorf("expected an operation or fragment, found %q", kw.text)
		}
		switch kw.text {
		case "query", "mutation":
			op := &gqlOperation{kind: kw.text}
			if p.peek().kind == tokName {
				op.name = p.next().text
			}
			if p.peek().kind == tokLParen {
				varDefs, err := p.parseVarDefs()
				if err != nil {
					return nil, err
				}
				op.varDefs = varDefs
			}
			if err := p.parseDirectives(); err != nil {
				return nil, err
			}
			sel, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			op.selection = sel
			doc.operations = append(doc.operations, op)
		case "fragment":
			nameTok, err := p.expect(tokName)
			if err != nil {
				return nil, err
			}
			if err := p.expectName("on"); err != nil {
				return nil, err
			}
			typeTok, err := p.expect(tokName)
			if err != nil {
				return nil, err
			}
			if err := p.parseDirectives(); err != nil {
				return nil, err
			}
			sel, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			doc.fragments[nameTok.text] = &gqlFragment{name: nameTok.text, typeCond: typeTok.text, selection: sel}
		default:
			return nil, fmt.Errorf("unexpected definition keyword %q", kw.text)
		}
	}
	if len(doc.operations) == 0 {
		return nil, fmt.Errorf("the document holds no operation")
	}
	return doc, nil
}

func (p *gqlParser) parseVarDefs() ([]gqlVarDef, error) {
	if _, err := p.expect(tokLParen); err != nil {
		return nil, err
	}
	var defs []gqlVarDef
	for p.peek().kind != tokRParen {
		if _, err := p.expect(tokDollar); err != nil {
			return nil, err
		}
		nameTok, err := p.expect(tokName)
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokColon); err != nil {
			return nil, err
		}
		if err := p.parseType(); err != nil {
			return nil, err
		}
		def := gqlVarDef{name: nameTok.text}
		if p.peek().kind == tokEquals {
			p.next()
			value, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			def.hasDefault = true
			def.defValue = value
		}
		if err := p.parseDirectives(); err != nil {
			return nil, err
		}
		defs = append(defs, def)
	}
	if _, err := p.expect(tokRParen); err != nil {
		return nil, err
	}
	return defs, nil
}

// parseType consumes a type expression (Named, [T], T!) without retaining it:
// variable values arrive as JSON and need no static type checks here.
func (p *gqlParser) parseType() error {
	t := p.next()
	switch t.kind {
	case tokLBracket:
		if err := p.parseType(); err != nil {
			return err
		}
		if _, err := p.expect(tokRBracket); err != nil {
			return err
		}
	case tokName:
	default:
		return fmt.Errorf("expected a type, found %q", t.text)
	}
	if p.peek().kind == tokBang {
		p.next()
	}
	return nil
}

func (p *gqlParser) parseDirectives() error {
	for p.peek().kind == tokAt {
		p.next()
		if _, err := p.expect(tokName); err != nil {
			return err
		}
		if p.peek().kind == tokLParen {
			if _, err := p.parseArguments(); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *gqlParser) parseSelectionSet() (*gqlSelectionSet, error) {
	if _, err := p.expect(tokLBrace); err != nil {
		return nil, err
	}
	set := &gqlSelectionSet{}
	for p.peek().kind != tokRBrace {
		if p.peek().kind == tokEOF {
			return nil, fmt.Errorf("selection set is not closed")
		}
		sel, err := p.parseSelection()
		if err != nil {
			return nil, err
		}
		set.selections = append(set.selections, sel)
	}
	if _, err := p.expect(tokRBrace); err != nil {
		return nil, err
	}
	return set, nil
}

func (p *gqlParser) parseSelection() (gqlSelection, error) {
	if p.peek().kind == tokSpread {
		p.next()
		if p.peek().kind == tokName && p.peek().text != "on" {
			nameTok := p.next()
			if err := p.parseDirectives(); err != nil {
				return gqlSelection{}, err
			}
			return gqlSelection{spread: &gqlFragmentSpread{name: nameTok.text}}, nil
		}
		frag := &gqlInlineFragment{}
		if p.peek().kind == tokName && p.peek().text == "on" {
			p.next()
			typeTok, err := p.expect(tokName)
			if err != nil {
				return gqlSelection{}, err
			}
			frag.typeCond = typeTok.text
		}
		if err := p.parseDirectives(); err != nil {
			return gqlSelection{}, err
		}
		sel, err := p.parseSelectionSet()
		if err != nil {
			return gqlSelection{}, err
		}
		frag.selection = sel
		return gqlSelection{fragment: frag}, nil
	}
	nameTok, err := p.expect(tokName)
	if err != nil {
		return gqlSelection{}, err
	}
	field := &gqlField{name: nameTok.text}
	if p.peek().kind == tokColon {
		p.next()
		realName, err := p.expect(tokName)
		if err != nil {
			return gqlSelection{}, err
		}
		field.alias = field.name
		field.name = realName.text
	}
	if p.peek().kind == tokLParen {
		args, err := p.parseArguments()
		if err != nil {
			return gqlSelection{}, err
		}
		field.args = args
	}
	if err := p.parseDirectives(); err != nil {
		return gqlSelection{}, err
	}
	if p.peek().kind == tokLBrace {
		sel, err := p.parseSelectionSet()
		if err != nil {
			return gqlSelection{}, err
		}
		field.selection = sel
	}
	return gqlSelection{field: field}, nil
}

func (p *gqlParser) parseArguments() (map[string]gqlValue, error) {
	if _, err := p.expect(tokLParen); err != nil {
		return nil, err
	}
	args := map[string]gqlValue{}
	for p.peek().kind != tokRParen {
		nameTok, err := p.expect(tokName)
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokColon); err != nil {
			return nil, err
		}
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		args[nameTok.text] = value
	}
	if _, err := p.expect(tokRParen); err != nil {
		return nil, err
	}
	return args, nil
}

func (p *gqlParser) parseValue() (gqlValue, error) {
	t := p.next()
	switch t.kind {
	case tokDollar:
		nameTok, err := p.expect(tokName)
		if err != nil {
			return gqlValue{}, err
		}
		return gqlValue{kind: gqlVar, str: nameTok.text}, nil
	case tokInt:
		return gqlValue{kind: gqlIntVal, str: t.text}, nil
	case tokFloat:
		return gqlValue{kind: gqlFloatVal, str: t.text}, nil
	case tokString:
		return gqlValue{kind: gqlStringVal, str: t.text}, nil
	case tokLBracket:
		var list []gqlValue
		for p.peek().kind != tokRBracket {
			v, err := p.parseValue()
			if err != nil {
				return gqlValue{}, err
			}
			list = append(list, v)
		}
		if _, err := p.expect(tokRBracket); err != nil {
			return gqlValue{}, err
		}
		return gqlValue{kind: gqlListVal, list: list}, nil
	case tokLBrace:
		obj := map[string]gqlValue{}
		for p.peek().kind != tokRBrace {
			nameTok, err := p.expect(tokName)
			if err != nil {
				return gqlValue{}, err
			}
			if _, err := p.expect(tokColon); err != nil {
				return gqlValue{}, err
			}
			v, err := p.parseValue()
			if err != nil {
				return gqlValue{}, err
			}
			obj[nameTok.text] = v
		}
		if _, err := p.expect(tokRBrace); err != nil {
			return gqlValue{}, err
		}
		return gqlValue{kind: gqlObjectVal, object: obj}, nil
	case tokName:
		switch t.text {
		case "true":
			return gqlValue{kind: gqlBoolVal, boolean: true}, nil
		case "false":
			return gqlValue{kind: gqlBoolVal, boolean: false}, nil
		case "null":
			return gqlValue{kind: gqlNullVal}, nil
		default:
			return gqlValue{kind: gqlEnumVal, str: t.text}, nil
		}
	default:
		return gqlValue{}, fmt.Errorf("unexpected value token %q", t.text)
	}
}

// ---------------------------------------------------------------------------
// Schema (the exact surface the kit documents)
// ---------------------------------------------------------------------------

var gqlFields = map[string]map[string]bool{
	"Query": {
		"viewer": true, "repository": true, "node": true, "__type": true,
	},
	"Mutation": {
		"createIssue": true, "closeIssue": true, "createPullRequest": true,
		"mergePullRequest": true, "addComment": true,
	},
	"User": {"login": true},
	"Repository": {
		"id": true, "databaseId": true, "name": true, "nameWithOwner": true,
		"owner": true, "defaultBranchRef": true, "viewerPermission": true,
		"hasIssuesEnabled": true, "issue": true, "issues": true,
		"pullRequests": true, "pullRequest": true,
	},
	"Ref": {"name": true},
	"Issue": {
		"id": true, "number": true, "title": true, "state": true, "body": true,
	},
	"IssueConnection": {"nodes": true, "pageInfo": true},
	"PageInfo":        {"hasNextPage": true, "endCursor": true},
	"PullRequest": {
		"id": true, "number": true, "state": true, "merged": true,
		"headRefName": true, "baseRefName": true, "mergeable": true, "files": true,
	},
	"PullRequestConnection":            {"nodes": true},
	"PullRequestChangedFileConnection": {"nodes": true},
	"PullRequestChangedFile":           {"path": true},
	"Node":                             {"id": true},
	"__Type": {
		"name": true, "kind": true, "description": true, "fields": true, "enumValues": true,
	},
	"__Field":                  {"name": true, "description": true},
	"__EnumValue":              {"name": true, "description": true},
	"CreateIssuePayload":       {"issue": true},
	"CloseIssuePayload":        {"issue": true},
	"CreatePullRequestPayload": {"pullRequest": true},
	"MergePullRequestPayload":  {"pullRequest": true},
	"AddCommentPayload":        {"commentEdge": true},
	"IssueCommentEdge":         {"node": true},
	"IssueComment":             {"id": true, "body": true},
}

// gqlFieldTypes gives the object type of a field's sub-selection (the element
// type for list fields). Scalar fields are absent.
var gqlFieldTypes = map[string]map[string]string{
	"Query": {
		"viewer": "User", "repository": "Repository", "node": "Node", "__type": "__Type",
	},
	"Mutation": {
		"createIssue": "CreateIssuePayload", "closeIssue": "CloseIssuePayload",
		"createPullRequest": "CreatePullRequestPayload",
		"mergePullRequest":  "MergePullRequestPayload", "addComment": "AddCommentPayload",
	},
	"Repository": {
		"owner": "User", "defaultBranchRef": "Ref", "issue": "Issue",
		"issues": "IssueConnection", "pullRequests": "PullRequestConnection",
		"pullRequest": "PullRequest",
	},
	"IssueConnection":                  {"nodes": "Issue", "pageInfo": "PageInfo"},
	"PullRequestConnection":            {"nodes": "PullRequest"},
	"PullRequest":                      {"files": "PullRequestChangedFileConnection"},
	"PullRequestChangedFileConnection": {"nodes": "PullRequestChangedFile"},
	"__Type":                           {"fields": "__Field", "enumValues": "__EnumValue"},
	"CreateIssuePayload":               {"issue": "Issue"},
	"CloseIssuePayload":                {"issue": "Issue"},
	"CreatePullRequestPayload":         {"pullRequest": "PullRequest"},
	"MergePullRequestPayload":          {"pullRequest": "PullRequest"},
	"AddCommentPayload":                {"commentEdge": "IssueCommentEdge"},
	"IssueCommentEdge":                 {"node": "IssueComment"},
}

type gqlTypeDef struct {
	name       string
	kind       string
	fields     []string
	enumValues []string
}

var gqlTypeDefs = map[string]*gqlTypeDef{
	"Issue": {
		name: "Issue", kind: "OBJECT",
		fields: []string{"id", "number", "title", "state", "body"},
	},
	"PullRequest": {
		name: "PullRequest", kind: "OBJECT",
		fields: []string{"id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files"},
	},
	"Repository": {
		name: "Repository", kind: "OBJECT",
		fields: []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest"},
	},
	"SearchType": {
		name: "SearchType", kind: "ENUM",
		enumValues: []string{"ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "CODE"},
	},
	"User": {
		name: "User", kind: "OBJECT",
		fields: []string{"login"},
	},
	"IssueState": {
		name: "IssueState", kind: "ENUM",
		enumValues: []string{"OPEN", "CLOSED"},
	},
	"PullRequestState": {
		name: "PullRequestState", kind: "ENUM",
		enumValues: []string{"OPEN", "CLOSED", "MERGED"},
	},
	"MergeableState": {
		name: "MergeableState", kind: "ENUM",
		enumValues: []string{"MERGEABLE", "CONFLICTING", "UNKNOWN"},
	},
	"RepositoryPermission": {
		name: "RepositoryPermission", kind: "ENUM",
		enumValues: []string{"ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"},
	},
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

func gqlValidate(doc *gqlDocument, op *gqlOperation) []string {
	var errs []string
	rootType := "Query"
	if op.kind == "mutation" {
		rootType = "Mutation"
	}
	validateSelectionSet(op.selection, rootType, doc.fragments, &errs, 0)
	return errs
}

func validateSelectionSet(sel *gqlSelectionSet, typeName string, fragments map[string]*gqlFragment, errs *[]string, depth int) {
	if depth > 64 || sel == nil {
		return
	}
	fields := gqlFields[typeName]
	for _, selection := range sel.selections {
		switch {
		case selection.field != nil:
			f := selection.field
			if f.name == "__typename" {
				continue
			}
			if fields == nil || !fields[f.name] {
				*errs = append(*errs, fmt.Sprintf("Cannot query field %q on type %q.", f.name, typeName))
				continue
			}
			if f.selection != nil {
				if child, ok := gqlFieldTypes[typeName][f.name]; ok {
					validateSelectionSet(f.selection, child, fragments, errs, depth+1)
				}
			}
		case selection.fragment != nil:
			cond := selection.fragment.typeCond
			if cond == "" {
				cond = typeName
			}
			if _, known := gqlFields[cond]; known {
				validateSelectionSet(selection.fragment.selection, cond, fragments, errs, depth+1)
			}
		case selection.spread != nil:
			if frag, ok := fragments[selection.spread.name]; ok {
				if _, known := gqlFields[frag.typeCond]; known {
					validateSelectionSet(frag.selection, frag.typeCond, fragments, errs, depth+1)
				}
			} else {
				*errs = append(*errs, fmt.Sprintf("Unknown fragment %q.", selection.spread.name))
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type gqlPageInfo struct {
	hasNextPage bool
	endCursor   *string
}

type gqlObj struct {
	typeName string
	repo     *Repo
	issue    *Issue
	pr       *PullRequest
	comment  *Comment
	// For IssueComment objects: the owning issue number (for the global id).
	commentIssueNum int
	// Connection payloads.
	issues   []*Issue
	pageInfo *gqlPageInfo
	prs      []*PullRequest
	files    []prFileJSON
	filePath string
	// Introspection.
	typeDef    *gqlTypeDef
	memberName string
	// Ref objects.
	refName string
}

type gqlExecutor struct {
	s         *Server
	variables map[string]any
	fragments map[string]*gqlFragment
	err       string // first execution error (mutation failure)
}

func (e *gqlExecutor) resolveValue(v gqlValue) any {
	switch v.kind {
	case gqlVar:
		if val, ok := e.variables[v.str]; ok {
			return val
		}
		return nil
	case gqlIntVal:
		if n, err := strconv.ParseInt(v.str, 10, 64); err == nil {
			return n
		}
		return v.str
	case gqlFloatVal:
		if f, err := strconv.ParseFloat(v.str, 64); err == nil {
			return f
		}
		return v.str
	case gqlStringVal:
		return v.str
	case gqlBoolVal:
		return v.boolean
	case gqlNullVal:
		return nil
	case gqlEnumVal:
		return v.str
	case gqlListVal:
		out := make([]any, 0, len(v.list))
		for _, item := range v.list {
			out = append(out, e.resolveValue(item))
		}
		return out
	case gqlObjectVal:
		out := map[string]any{}
		for key, item := range v.object {
			out[key] = e.resolveValue(item)
		}
		return out
	}
	return nil
}

func (e *gqlExecutor) resolveArgs(f *gqlField) map[string]any {
	args := map[string]any{}
	for name, v := range f.args {
		args[name] = e.resolveValue(v)
	}
	return args
}

// --- argument coercion helpers (JSON numbers arrive as float64) ---

func argString(args map[string]any, name string) string {
	if s, ok := args[name].(string); ok {
		return s
	}
	return ""
}

func argInt(args map[string]any, name string, def int) int {
	switch v := args[name].(type) {
	case nil:
		return def
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return int(n)
		}
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func argStringList(args map[string]any, name string) []string {
	raw, ok := args[name].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func argObject(args map[string]any, name string) map[string]any {
	if m, ok := args[name].(map[string]any); ok {
		return m
	}
	return nil
}

// --- selection execution ---

func (e *gqlExecutor) executeSelectionSet(sel *gqlSelectionSet, obj *gqlObj, out map[string]any) {
	for _, selection := range sel.selections {
		if e.err != "" {
			return
		}
		switch {
		case selection.field != nil:
			e.executeField(selection.field, obj, out)
		case selection.fragment != nil:
			if fragmentApplies(selection.fragment.typeCond, obj.typeName) {
				e.executeSelectionSet(selection.fragment.selection, obj, out)
			}
		case selection.spread != nil:
			if frag, ok := e.fragments[selection.spread.name]; ok && fragmentApplies(frag.typeCond, obj.typeName) {
				e.executeSelectionSet(frag.selection, obj, out)
			}
		}
	}
}

func fragmentApplies(typeCond, typeName string) bool {
	if typeCond == "" || typeCond == typeName {
		return true
	}
	// Repository implements the Node interface.
	if typeCond == "Node" && typeName == "Repository" {
		return true
	}
	return false
}

type gqlFieldResult struct {
	scalar any
	obj    *gqlObj
	list   []*gqlObj
	isList bool
	isNull bool
}

func (e *gqlExecutor) executeField(f *gqlField, obj *gqlObj, out map[string]any) {
	key := f.name
	if f.alias != "" {
		key = f.alias
	}
	if f.name == "__typename" {
		out[key] = obj.typeName
		return
	}
	args := e.resolveArgs(f)
	result := e.resolveField(obj, f.name, args)
	if e.err != "" {
		return
	}
	if result.isNull || (f.selection == nil && result.obj == nil && !result.isList) {
		if result.isNull {
			out[key] = nil
		} else {
			out[key] = result.scalar
		}
		return
	}
	if f.selection == nil {
		out[key] = result.scalar
		return
	}
	if result.isList {
		arr := make([]any, 0, len(result.list))
		for _, elem := range result.list {
			child := map[string]any{}
			e.executeSelectionSet(f.selection, elem, child)
			arr = append(arr, child)
		}
		out[key] = arr
		return
	}
	child := map[string]any{}
	e.executeSelectionSet(f.selection, result.obj, child)
	out[key] = child
}

// resolveField computes one field's value. Callers hold Store.mu (read for
// queries, write for mutations).
func (e *gqlExecutor) resolveField(obj *gqlObj, name string, args map[string]any) gqlFieldResult {
	scalar := func(v any) gqlFieldResult { return gqlFieldResult{scalar: v} }
	null := func() gqlFieldResult { return gqlFieldResult{isNull: true} }

	switch obj.typeName {
	case "Query":
		switch name {
		case "viewer":
			return gqlFieldResult{obj: &gqlObj{typeName: "User"}}
		case "repository":
			repo := e.s.store.lookup(argString(args, "owner"), argString(args, "name"))
			if repo == nil {
				return null()
			}
			return gqlFieldResult{obj: &gqlObj{typeName: "Repository", repo: repo}}
		case "node":
			return e.resolveNode(argString(args, "id"))
		case "__type":
			def, ok := gqlTypeDefs[argString(args, "name")]
			if !ok {
				return null()
			}
			return gqlFieldResult{obj: &gqlObj{typeName: "__Type", typeDef: def}}
		}
	case "Mutation":
		switch name {
		case "createIssue":
			return e.mutateCreateIssue(args)
		case "closeIssue":
			return e.mutateCloseIssue(args)
		case "createPullRequest":
			return e.mutateCreatePullRequest(args)
		case "mergePullRequest":
			return e.mutateMergePullRequest(args)
		case "addComment":
			return e.mutateAddComment(args)
		}
	case "User":
		if name == "login" {
			return scalar(viewerLogin)
		}
	case "Repository":
		repo := obj.repo
		switch name {
		case "id":
			return scalar(repoGlobalID(repo))
		case "databaseId":
			return scalar(repo.ID)
		case "name":
			return scalar(repo.Name)
		case "nameWithOwner":
			return scalar(repo.Owner + "/" + repo.Name)
		case "owner":
			return gqlFieldResult{obj: &gqlObj{typeName: "User"}}
		case "defaultBranchRef":
			if _, ok := repo.branchTip(repo.DefaultBranch); !ok {
				return null()
			}
			return gqlFieldResult{obj: &gqlObj{typeName: "Ref", refName: repo.DefaultBranch}}
		case "viewerPermission":
			return scalar("ADMIN")
		case "hasIssuesEnabled":
			return scalar(true)
		case "issue":
			issue := repo.IssuesByNum[argInt(args, "number", 0)]
			if issue == nil {
				return null()
			}
			return gqlFieldResult{obj: &gqlObj{typeName: "Issue", repo: repo, issue: issue}}
		case "issues":
			return e.resolveIssues(repo, args)
		case "pullRequests":
			return e.resolvePullRequests(repo, args)
		case "pullRequest":
			pr := repo.PRsByNum[argInt(args, "number", 0)]
			if pr == nil {
				return null()
			}
			return gqlFieldResult{obj: &gqlObj{typeName: "PullRequest", repo: repo, pr: pr}}
		}
	case "Ref":
		if name == "name" {
			return scalar(obj.refName)
		}
	case "Issue":
		issue := obj.issue
		switch name {
		case "id":
			return scalar(issueGlobalID(obj.repo, issue.Number))
		case "number":
			return scalar(issue.Number)
		case "title":
			return scalar(issue.Title)
		case "state":
			if issue.State == "closed" {
				return scalar("CLOSED")
			}
			return scalar("OPEN")
		case "body":
			return scalar(issue.Body)
		}
	case "IssueConnection":
		switch name {
		case "nodes":
			list := make([]*gqlObj, 0, len(obj.issues))
			for _, issue := range obj.issues {
				list = append(list, &gqlObj{typeName: "Issue", repo: obj.repo, issue: issue})
			}
			return gqlFieldResult{list: list, isList: true}
		case "pageInfo":
			return gqlFieldResult{obj: &gqlObj{typeName: "PageInfo", pageInfo: obj.pageInfo}}
		}
	case "PageInfo":
		switch name {
		case "hasNextPage":
			return scalar(obj.pageInfo.hasNextPage)
		case "endCursor":
			if obj.pageInfo.endCursor == nil {
				return null()
			}
			return scalar(*obj.pageInfo.endCursor)
		}
	case "PullRequest":
		pr := obj.pr
		switch name {
		case "id":
			return scalar(prGlobalID(obj.repo, pr.Number))
		case "number":
			return scalar(pr.Number)
		case "state":
			switch {
			case pr.Merged:
				return scalar("MERGED")
			case pr.State == "closed":
				return scalar("CLOSED")
			default:
				return scalar("OPEN")
			}
		case "merged":
			return scalar(pr.Merged)
		case "headRefName":
			return scalar(pr.HeadRef)
		case "baseRefName":
			return scalar(pr.BaseRef)
		case "mergeable":
			return scalar(e.mergeableState(obj.repo, pr))
		case "files":
			first := argInt(args, "first", 30)
			baseTip, _ := obj.repo.branchTip(pr.BaseRef)
			headTip, _ := obj.repo.branchTip(pr.HeadRef)
			files := obj.repo.diffFiles(baseTip, headTip)
			if first >= 0 && len(files) > first {
				files = files[:first]
			}
			return gqlFieldResult{obj: &gqlObj{typeName: "PullRequestChangedFileConnection", repo: obj.repo, files: files}}
		}
	case "PullRequestConnection":
		if name == "nodes" {
			list := make([]*gqlObj, 0, len(obj.prs))
			for _, pr := range obj.prs {
				list = append(list, &gqlObj{typeName: "PullRequest", repo: obj.repo, pr: pr})
			}
			return gqlFieldResult{list: list, isList: true}
		}
	case "PullRequestChangedFileConnection":
		if name == "nodes" {
			list := make([]*gqlObj, 0, len(obj.files))
			for _, f := range obj.files {
				list = append(list, &gqlObj{typeName: "PullRequestChangedFile", filePath: f.Filename})
			}
			return gqlFieldResult{list: list, isList: true}
		}
	case "PullRequestChangedFile":
		if name == "path" {
			return scalar(obj.filePath)
		}
	case "__Type":
		def := obj.typeDef
		switch name {
		case "name":
			return scalar(def.name)
		case "kind":
			return scalar(def.kind)
		case "description":
			return scalar("")
		case "fields":
			list := make([]*gqlObj, 0, len(def.fields))
			for _, fieldName := range def.fields {
				list = append(list, &gqlObj{typeName: "__Field", memberName: fieldName})
			}
			return gqlFieldResult{list: list, isList: true}
		case "enumValues":
			list := make([]*gqlObj, 0, len(def.enumValues))
			for _, valueName := range def.enumValues {
				list = append(list, &gqlObj{typeName: "__EnumValue", memberName: valueName})
			}
			return gqlFieldResult{list: list, isList: true}
		}
	case "__Field", "__EnumValue":
		switch name {
		case "name":
			return scalar(obj.memberName)
		case "description":
			return scalar("")
		}
	case "CreateIssuePayload", "CloseIssuePayload":
		if name == "issue" {
			return gqlFieldResult{obj: &gqlObj{typeName: "Issue", repo: obj.repo, issue: obj.issue}}
		}
	case "CreatePullRequestPayload", "MergePullRequestPayload":
		if name == "pullRequest" {
			return gqlFieldResult{obj: &gqlObj{typeName: "PullRequest", repo: obj.repo, pr: obj.pr}}
		}
	case "AddCommentPayload":
		if name == "commentEdge" {
			return gqlFieldResult{obj: &gqlObj{
				typeName: "IssueCommentEdge", repo: obj.repo,
				comment: obj.comment, commentIssueNum: obj.commentIssueNum,
			}}
		}
	case "IssueCommentEdge":
		if name == "node" {
			return gqlFieldResult{obj: &gqlObj{
				typeName: "IssueComment", repo: obj.repo,
				comment: obj.comment, commentIssueNum: obj.commentIssueNum,
			}}
		}
	case "IssueComment":
		switch name {
		case "id":
			return scalar(commentGlobalID(obj.repo, obj.commentIssueNum, obj.comment.ID))
		case "body":
			return scalar(obj.comment.Body)
		}
	}
	return null()
}

func (e *gqlExecutor) resolveNode(id string) gqlFieldResult {
	kind, parts, ok := decodeGlobalID(id)
	if !ok {
		return gqlFieldResult{isNull: true}
	}
	switch kind {
	case "Repository":
		if len(parts) == 1 {
			if repo := e.s.store.byID[parts[0]]; repo != nil {
				return gqlFieldResult{obj: &gqlObj{typeName: "Repository", repo: repo}}
			}
		}
	case "Issue":
		if len(parts) == 2 {
			if repo := e.s.store.byID[parts[0]]; repo != nil {
				if issue := repo.IssuesByNum[int(parts[1])]; issue != nil {
					return gqlFieldResult{obj: &gqlObj{typeName: "Issue", repo: repo, issue: issue}}
				}
			}
		}
	case "PullRequest":
		if len(parts) == 2 {
			if repo := e.s.store.byID[parts[0]]; repo != nil {
				if pr := repo.PRsByNum[int(parts[1])]; pr != nil {
					return gqlFieldResult{obj: &gqlObj{typeName: "PullRequest", repo: repo, pr: pr}}
				}
			}
		}
	}
	return gqlFieldResult{isNull: true}
}

// --- connections ---

func issueCursor(number int) string {
	return base64.StdEncoding.EncodeToString([]byte("issue-cursor:" + strconv.Itoa(number)))
}

func decodeIssueCursor(cursor string) (int, bool) {
	raw, err := base64.StdEncoding.DecodeString(cursor)
	if err != nil {
		return 0, false
	}
	text := string(raw)
	if !strings.HasPrefix(text, "issue-cursor:") {
		return 0, false
	}
	n, err := strconv.Atoi(text[len("issue-cursor:"):])
	if err != nil {
		return 0, false
	}
	return n, true
}

func (e *gqlExecutor) resolveIssues(repo *Repo, args map[string]any) gqlFieldResult {
	first := argInt(args, "first", 30)
	states := argStringList(args, "states")
	orderBy := argObject(args, "orderBy")
	direction := "ASC"
	if orderBy != nil {
		if d, ok := orderBy["direction"].(string); ok && d != "" {
			direction = d
		}
	}
	// UPDATED_AT and COMMENTS orderings behave as CREATED_AT here: number
	// order is the only creation order the store keeps.
	after := argString(args, "after")
	afterNum := 0
	if after != "" {
		if n, ok := decodeIssueCursor(after); ok {
			afterNum = n
		}
	}

	// Filter by state, in ascending number order first.
	var ordered []*Issue
	for _, issue := range repo.Issues {
		if len(states) > 0 {
			want := false
			for _, state := range states {
				if (state == "OPEN" && issue.State == "open") || (state == "CLOSED" && issue.State == "closed") {
					want = true
					break
				}
			}
			if !want {
				continue
			}
		}
		ordered = append(ordered, issue)
	}
	if direction == "DESC" {
		for i, j := 0, len(ordered)-1; i < j; i, j = i+1, j-1 {
			ordered[i], ordered[j] = ordered[j], ordered[i]
		}
	}
	// Apply the cursor: skip everything up to and including the cursor's
	// issue, in the current order.
	start := 0
	if afterNum != 0 {
		for i, issue := range ordered {
			if issue.Number == afterNum {
				start = i + 1
				break
			}
		}
	}
	if start > len(ordered) {
		start = len(ordered)
	}
	ordered = ordered[start:]
	hasNext := false
	if first >= 0 && len(ordered) > first {
		ordered = ordered[:first]
		hasNext = true
	}
	var endCursor *string
	if len(ordered) > 0 {
		cursor := issueCursor(ordered[len(ordered)-1].Number)
		endCursor = &cursor
	}
	return gqlFieldResult{obj: &gqlObj{
		typeName: "IssueConnection", repo: repo, issues: ordered,
		pageInfo: &gqlPageInfo{hasNextPage: hasNext, endCursor: endCursor},
	}}
}

func (e *gqlExecutor) resolvePullRequests(repo *Repo, args map[string]any) gqlFieldResult {
	first := argInt(args, "first", 30)
	var prs []*PullRequest
	for i := len(repo.PRs) - 1; i >= 0; i-- {
		pr := repo.PRs[i]
		if pr.State != "open" {
			continue
		}
		prs = append(prs, pr)
	}
	if first >= 0 && len(prs) > first {
		prs = prs[:first]
	}
	return gqlFieldResult{obj: &gqlObj{typeName: "PullRequestConnection", repo: repo, prs: prs}}
}

func (e *gqlExecutor) mergeableState(repo *Repo, pr *PullRequest) string {
	if pr.State != "open" {
		return "UNKNOWN"
	}
	baseTip, baseOK := repo.branchTip(pr.BaseRef)
	headTip, headOK := repo.branchTip(pr.HeadRef)
	if !baseOK || !headOK {
		return "UNKNOWN"
	}
	if repo.mergeConflict(baseTip, headTip) {
		return "CONFLICTING"
	}
	return "MERGEABLE"
}

// --- mutations (callers hold the write lock) ---

func (e *gqlExecutor) repoFromGlobalID(id string) *Repo {
	kind, parts, ok := decodeGlobalID(id)
	if !ok || kind != "Repository" || len(parts) != 1 {
		return nil
	}
	return e.s.store.byID[parts[0]]
}

func (e *gqlExecutor) issueFromGlobalID(id string) (*Repo, *Issue) {
	kind, parts, ok := decodeGlobalID(id)
	if !ok || kind != "Issue" || len(parts) != 2 {
		return nil, nil
	}
	repo := e.s.store.byID[parts[0]]
	if repo == nil {
		return nil, nil
	}
	return repo, repo.IssuesByNum[int(parts[1])]
}

func (e *gqlExecutor) prFromGlobalID(id string) (*Repo, *PullRequest) {
	kind, parts, ok := decodeGlobalID(id)
	if !ok || kind != "PullRequest" || len(parts) != 2 {
		return nil, nil
	}
	repo := e.s.store.byID[parts[0]]
	if repo == nil {
		return nil, nil
	}
	return repo, repo.PRsByNum[int(parts[1])]
}

func (e *gqlExecutor) mutateCreateIssue(args map[string]any) gqlFieldResult {
	input := argObject(args, "input")
	if input == nil {
		e.err = "createIssue requires an input object"
		return gqlFieldResult{isNull: true}
	}
	repo := e.repoFromGlobalID(argString(input, "repositoryId"))
	if repo == nil {
		e.err = "createIssue names an unknown repository"
		return gqlFieldResult{isNull: true}
	}
	title := argString(input, "title")
	issue := &Issue{
		ID:     e.s.store.nextID,
		Number: repo.NextIssue,
		Title:  title,
		Body:   argString(input, "body"),
		State:  "open",
		Labels: []string{},
	}
	e.s.store.nextID++
	repo.NextIssue++
	repo.Issues = append(repo.Issues, issue)
	repo.IssuesByNum[issue.Number] = issue
	e.s.cacheIssueJSON(repo, issue)
	return gqlFieldResult{obj: &gqlObj{typeName: "CreateIssuePayload", repo: repo, issue: issue}}
}

func (e *gqlExecutor) mutateCloseIssue(args map[string]any) gqlFieldResult {
	input := argObject(args, "input")
	if input == nil {
		e.err = "closeIssue requires an input object"
		return gqlFieldResult{isNull: true}
	}
	repo, issue := e.issueFromGlobalID(argString(input, "issueId"))
	if repo == nil || issue == nil {
		e.err = "closeIssue names an unknown issue"
		return gqlFieldResult{isNull: true}
	}
	issue.State = "closed"
	e.s.cacheIssueJSON(repo, issue)
	return gqlFieldResult{obj: &gqlObj{typeName: "CloseIssuePayload", repo: repo, issue: issue}}
}

func (e *gqlExecutor) mutateCreatePullRequest(args map[string]any) gqlFieldResult {
	input := argObject(args, "input")
	if input == nil {
		e.err = "createPullRequest requires an input object"
		return gqlFieldResult{isNull: true}
	}
	repo := e.repoFromGlobalID(argString(input, "repositoryId"))
	if repo == nil {
		e.err = "createPullRequest names an unknown repository"
		return gqlFieldResult{isNull: true}
	}
	head := argString(input, "headRefName")
	base := argString(input, "baseRefName")
	headSHA, headOK := repo.branchTip(head)
	baseSHA, baseOK := repo.branchTip(base)
	if !headOK || !baseOK {
		e.err = "createPullRequest names a branch that does not exist"
		return gqlFieldResult{isNull: true}
	}
	pr := &PullRequest{
		ID:      e.s.store.nextID,
		Number:  repo.NextPR,
		Title:   argString(input, "title"),
		Body:    argString(input, "body"),
		State:   "open",
		HeadRef: head,
		HeadSHA: headSHA,
		BaseRef: base,
		BaseSHA: baseSHA,
	}
	e.s.store.nextID++
	repo.NextPR++
	repo.PRs = append(repo.PRs, pr)
	repo.PRsByNum[pr.Number] = pr
	return gqlFieldResult{obj: &gqlObj{typeName: "CreatePullRequestPayload", repo: repo, pr: pr}}
}

func (e *gqlExecutor) mutateMergePullRequest(args map[string]any) gqlFieldResult {
	input := argObject(args, "input")
	if input == nil {
		e.err = "mergePullRequest requires an input object"
		return gqlFieldResult{isNull: true}
	}
	repo, pr := e.prFromGlobalID(argString(input, "pullRequestId"))
	if repo == nil || pr == nil {
		e.err = "mergePullRequest names an unknown pull request"
		return gqlFieldResult{isNull: true}
	}
	if _, errStr := repo.mergePullRequest(pr); errStr != "" {
		e.err = "mergePullRequest cannot merge this pull request: " + errStr
		return gqlFieldResult{isNull: true}
	}
	return gqlFieldResult{obj: &gqlObj{typeName: "MergePullRequestPayload", repo: repo, pr: pr}}
}

func (e *gqlExecutor) mutateAddComment(args map[string]any) gqlFieldResult {
	input := argObject(args, "input")
	if input == nil {
		e.err = "addComment requires an input object"
		return gqlFieldResult{isNull: true}
	}
	repo, issue := e.issueFromGlobalID(argString(input, "subjectId"))
	if repo == nil || issue == nil {
		e.err = "addComment names an unknown subject"
		return gqlFieldResult{isNull: true}
	}
	comment := &Comment{ID: e.s.store.nextID, Body: argString(input, "body")}
	e.s.store.nextID++
	issue.Comments = append(issue.Comments, comment)
	return gqlFieldResult{obj: &gqlObj{
		typeName: "AddCommentPayload", repo: repo,
		comment: comment, commentIssueNum: issue.Number,
	}}
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

type gqlError struct {
	Message string `json:"message"`
}

type gqlEnvelope struct {
	Data   any        `json:"data"`
	Errors []gqlError `json:"errors,omitempty"`
}

type gqlRequest struct {
	Query         string         `json:"query"`
	Variables     map[string]any `json:"variables"`
	OperationName string         `json:"operationName"`
}

func (s *Server) handleGraphQL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeErr(w, http.StatusNotFound, "Not Found")
		return
	}
	if !s.authed(r) {
		s.writeErr(w, http.StatusUnauthorized, "Requires authentication")
		return
	}
	body := readBody(r)
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		s.writeErr(w, http.StatusBadRequest, "request body is empty")
		return
	}
	if trimmed[0] == '[' {
		var rawList []json.RawMessage
		if err := json.Unmarshal(trimmed, &rawList); err != nil {
			s.writeErr(w, http.StatusBadRequest, "Malformed JSON in request body")
			return
		}
		envelopes := make([]gqlEnvelope, 0, len(rawList))
		for _, raw := range rawList {
			var req gqlRequest
			if err := json.Unmarshal(raw, &req); err != nil {
				envelopes = append(envelopes, gqlEnvelope{Errors: []gqlError{{Message: "Malformed JSON in request body"}}})
				continue
			}
			envelopes = append(envelopes, s.executeGraphQL(&req))
		}
		s.writeJSON(w, http.StatusOK, envelopes)
		return
	}
	var req gqlRequest
	if err := json.Unmarshal(trimmed, &req); err != nil {
		s.writeErr(w, http.StatusBadRequest, "Malformed JSON in request body")
		return
	}
	s.writeJSON(w, http.StatusOK, s.executeGraphQL(&req))
}

func (s *Server) executeGraphQL(req *gqlRequest) gqlEnvelope {
	fail := func(message string) gqlEnvelope {
		return gqlEnvelope{Errors: []gqlError{{Message: message}}}
	}
	if strings.TrimSpace(req.Query) == "" {
		return fail("Must provide query string.")
	}
	doc, err := gqlParse(req.Query)
	if err != nil {
		return fail("Syntax Error: " + err.Error())
	}
	var op *gqlOperation
	if req.OperationName != "" {
		for _, cand := range doc.operations {
			if cand.name == req.OperationName {
				op = cand
				break
			}
		}
		if op == nil {
			return fail("Unknown operation named " + req.OperationName + ".")
		}
	} else if len(doc.operations) == 1 {
		op = doc.operations[0]
	} else {
		return fail("Must provide operation name if query contains multiple operations.")
	}
	if problems := gqlValidate(doc, op); len(problems) > 0 {
		errs := make([]gqlError, 0, len(problems))
		for _, problem := range problems {
			errs = append(errs, gqlError{Message: problem})
		}
		return gqlEnvelope{Errors: errs}
	}
	variables := map[string]any{}
	for k, v := range req.Variables {
		variables[k] = v
	}
	executor := &gqlExecutor{s: s, variables: variables, fragments: doc.fragments}
	// Apply variable defaults for variables the request did not supply.
	for _, def := range op.varDefs {
		if _, provided := variables[def.name]; !provided && def.hasDefault {
			variables[def.name] = executor.resolveValue(def.defValue)
		}
	}
	rootType := "Query"
	if op.kind == "mutation" {
		rootType = "Mutation"
		s.store.mu.Lock()
		defer s.store.mu.Unlock()
	} else {
		s.store.mu.RLock()
		defer s.store.mu.RUnlock()
	}
	data := map[string]any{}
	executor.executeSelectionSet(op.selection, &gqlObj{typeName: rootType}, data)
	if executor.err != "" {
		return fail(executor.err)
	}
	return gqlEnvelope{Data: data}
}
