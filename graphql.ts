// GraphQL executor: a real lexer, parser, validator, and executor for the
// GitHub-flavored schema surface the suite exercises. Supports variables,
// aliases, inline fragments, fragment spreads, input objects, enums, batch
// requests, and __type introspection. Unknown fields are rejected with a
// GraphQL error naming the field, as the specification requires.

import { mergeBase } from './objects.ts';
import { Forge, globalId, parseGlobalId, type IssueRec, type PullRec, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', ':', '$', '!', '=', '[', ']', '@', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= source.length) throw new Error('unterminated string');
        const c = source[j];
        if (c === '"') break;
        if (c === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 'r') value += '\r';
          else if (esc === 't') value += '\t';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
          continue;
        }
        value += c;
        j++;
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j++;
      while (j < source.length && /[0-9]/.test(source[j])) j++;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j++;
        while (j < source.length && /[0-9]/.test(source[j])) j++;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j++;
        if (source[j] === '+' || source[j] === '-') j++;
        while (j < source.length && /[0-9]/.test(source[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}' but got '${token.value}'`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name but got '${token.value}'`);
    if (value !== undefined && token.value !== value) throw new Error(`expected '${value}' but got '${token.value}'`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        const selection = this.parseSelectionSet();
        operations.push({ kind: 'operation', operation, name, variables, selection });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selection });
      } else {
        throw new Error(`unexpected token '${token.value}' at document level`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseTypeRef();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue(true);
        }
        this.skipDirectives();
        defs.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseTypeRef(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue(false) });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(constLiteral: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (constLiteral) throw new Error('variable in constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(constLiteral));
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constLiteral) });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token '${token.value}'`);
  }
}

// ---------------------------------------------------------------------------
// Schema table (field sets double as the introspection source)
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'SCALAR';
  fields: Record<string, string>;
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' } },
  Mutation: { kind: 'OBJECT', fields: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' } },
  User: { kind: 'OBJECT', fields: { login: 'String' } },
  Repository: { kind: 'OBJECT', fields: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' } },
  Ref: { kind: 'OBJECT', fields: { name: 'String' } },
  Issue: { kind: 'OBJECT', fields: { id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String' } },
  IssueConnection: { kind: 'OBJECT', fields: { nodes: '[Issue]', pageInfo: 'PageInfo' } },
  PageInfo: { kind: 'OBJECT', fields: { hasNextPage: 'Boolean', endCursor: 'String' } },
  PullRequest: { kind: 'OBJECT', fields: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection' } },
  PullRequestConnection: { kind: 'OBJECT', fields: { nodes: '[PullRequest]', pageInfo: 'PageInfo' } },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo' } },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: 'String' } },
  IssueComment: { kind: 'OBJECT', fields: { id: 'ID', body: 'String' } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: 'IssueComment', cursor: 'String' } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: 'Issue' } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: 'Issue' } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: 'PullRequest' } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: 'PullRequest' } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: 'IssueCommentEdge' } },
  Node: { kind: 'INTERFACE', fields: { id: 'ID' } },
  __Type: { kind: 'OBJECT', fields: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' } },
  __Field: { kind: 'OBJECT', fields: { name: 'String' } },
  __EnumValue: { kind: 'OBJECT', fields: { name: 'String' } },
  IssueState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: {}, enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  SearchType: { kind: 'ENUM', fields: {}, enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function innerType(typeRef: string): string {
  return typeRef.replace(/[\[\]!]/g, '');
}

function isListType(typeRef: string): boolean {
  return typeRef.startsWith('[');
}

// ---------------------------------------------------------------------------
// Validation: unknown fields (and unknown fragment types) are errors.
// ---------------------------------------------------------------------------

function validateSelection(
  typeName: string,
  selections: SelectionNode[],
  fragments: Map<string, FragmentNode>,
  errors: string[],
  visitedSpreads: Set<string>,
): void {
  const def = SCHEMA[typeName];
  if (!def) return;
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      const fieldType = def.fields[selection.name];
      if (!fieldType) {
        errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
        continue;
      }
      if (selection.selection) {
        const inner = innerType(fieldType);
        if (!SCALARS.has(inner)) validateSelection(inner, selection.selection, fragments, errors, new Set(visitedSpreads));
      }
    } else if (selection.kind === 'spread') {
      if (visitedSpreads.has(selection.name)) continue;
      visitedSpreads.add(selection.name);
      const fragment = fragments.get(selection.name);
      if (!fragment) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      if (!SCHEMA[fragment.typeCondition]) {
        errors.push(`Unknown type "${fragment.typeCondition}".`);
        continue;
      }
      validateSelection(fragment.typeCondition, fragment.selection, fragments, errors, visitedSpreads);
    } else {
      const condition = selection.typeCondition ?? typeName;
      if (!SCHEMA[condition]) {
        errors.push(`Unknown type "${condition}".`);
        continue;
      }
      validateSelection(condition, selection.selection, fragments, errors, new Set(visitedSpreads));
    }
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type GqlObject = { __typename: string; [key: string]: unknown };
type GqlValue = null | string | number | boolean | GqlObject | GqlValue[];

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

function evalValue(node: ValueNode, ctx: ExecContext, operation: OperationNode): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name] ?? null;
      const def = operation.variables.find((v) => v.name === node.name);
      return def?.defaultValue ? evalValue(def.defaultValue, ctx, operation) : null;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, ctx, operation));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx, operation);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, ctx: ExecContext, operation: OperationNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, ctx, operation);
  return out;
}

function fragmentApplies(condition: string | null, typename: string): boolean {
  if (condition === null) return true;
  if (condition === typename) return true;
  if (condition === 'Node') return typename === 'Repository' || typename === 'Issue' || typename === 'PullRequest' || typename === 'IssueComment';
  return false;
}

function executeSelection(obj: GqlObject, selections: SelectionNode[], ctx: ExecContext, operation: OperationNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = obj.__typename;
        continue;
      }
      const args = evalArgs(selection, ctx, operation);
      const raw = resolveField(obj, selection.name, args, ctx);
      out[key] = completeValue(raw, selection, ctx, operation);
    } else if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) continue;
      if (!fragmentApplies(fragment.typeCondition, obj.__typename)) continue;
      Object.assign(out, executeSelection(obj, fragment.selection, ctx, operation));
    } else {
      if (!fragmentApplies(selection.typeCondition, obj.__typename)) continue;
      Object.assign(out, executeSelection(obj, selection.selection, ctx, operation));
    }
  }
  return out;
}

function completeValue(raw: GqlValue, field: FieldNode, ctx: ExecContext, operation: OperationNode): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(item, field, ctx, operation));
  if (typeof raw === 'object') {
    if (!field.selection) return null;
    return executeSelection(raw, field.selection, ctx, operation);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

function wrapRepo(forge: Forge, repo: Repo): GqlObject {
  return { __typename: 'Repository', forge, repo };
}

function wrapIssue(forge: Forge, repo: Repo, issue: IssueRec): GqlObject {
  return { __typename: 'Issue', forge, repo, issue };
}

function wrapPull(forge: Forge, repo: Repo, pr: PullRec): GqlObject {
  return { __typename: 'PullRequest', forge, repo, pr };
}

function repoByDatabaseId(forge: Forge, databaseId: number): Repo | null {
  for (const repo of forge.repos.values()) {
    if (repo.databaseId === databaseId) return repo;
  }
  return null;
}

function encodeCursor(direction: string, lastNumber: number): string {
  return Buffer.from(`cursor:${direction}:${lastNumber}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): { direction: string; lastNumber: number } | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3 || parts[0] !== 'cursor') return null;
    const lastNumber = parseInt(parts[2], 10);
    if (!Number.isFinite(lastNumber)) return null;
    return { direction: parts[1], lastNumber };
  } catch {
    return null;
  }
}

function issueConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlObject {
  const statesRaw = args['states'];
  const wanted = new Set<string>();
  if (Array.isArray(statesRaw)) {
    for (const s of statesRaw) if (typeof s === 'string') wanted.add(s.toUpperCase());
  }
  const orderBy = (args['orderBy'] as Record<string, unknown> | null | undefined) ?? null;
  const direction = String(orderBy?.['direction'] ?? 'ASC').toUpperCase();
  const descending = direction === 'DESC';
  let list = [...repo.issues.values()];
  if (wanted.size > 0) {
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = typeof args['after'] === 'string' ? decodeCursor(args['after']) : null;
  if (after) {
    const idx = list.findIndex((issue) => issue.number === after.lastNumber);
    if (idx !== -1) list = list.slice(idx + 1);
  }
  const first = typeof args['first'] === 'number' ? args['first'] : null;
  const hasNextPage = first !== null && list.length > first;
  const page = first !== null ? list.slice(0, first) : list;
  const endCursor = page.length > 0 ? encodeCursor(descending ? 'DESC' : 'ASC', page[page.length - 1].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => wrapIssue(forge, repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function squashMergePr(forge: Forge, repo: Repo, pr: PullRec): boolean {
  if (pr.merged || pr.state !== 'open') return false;
  const headTip = repo.branchTip(pr.headRef) ?? pr.headShaAtCreation;
  const baseTip = repo.branchTip(pr.baseRef) ?? pr.baseShaAtCreation;
  const base = mergeBase(repo.objects, baseTip, headTip);
  const { merged, conflicts } = repo.threeWayMerge(base, baseTip, headTip);
  if (conflicts.length > 0) return false;
  const seq = forge.tick();
  const sha = repo.commitOnBranch(pr.baseRef, merged, `Squash merge #${pr.number}: ${pr.title}`, forge.epochFor(seq));
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = forge.isoFor(seq);
  pr.mergeCommitSha = sha;
  return true;
}

function resolveField(obj: GqlObject, field: string, args: Record<string, unknown>, ctx: ExecContext): GqlValue {
  const forge = ctx.forge;
  switch (obj.__typename) {
    case 'Query': {
      if (field === 'viewer') {
        const login = forge.viewerLogin();
        if (!login) return null;
        return { __typename: 'User', login };
      }
      if (field === 'repository') {
        const owner = String(args['owner'] ?? '');
        const name = String(args['name'] ?? '');
        const repo = forge.repoFor(owner, name);
        return repo ? wrapRepo(forge, repo) : null;
      }
      if (field === 'node') {
        const parsed = parseGlobalId(String(args['id'] ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = repoByDatabaseId(forge, parseInt(parsed.parts[0], 10));
          return repo ? wrapRepo(forge, repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const repo = repoByDatabaseId(forge, parseInt(parsed.parts[0], 10));
          const issue = repo?.issues.get(parseInt(parsed.parts[1], 10));
          return repo && issue ? wrapIssue(forge, repo, issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const repo = repoByDatabaseId(forge, parseInt(parsed.parts[0], 10));
          const pr = repo?.pulls.get(parseInt(parsed.parts[1], 10));
          return repo && pr ? wrapPull(forge, repo, pr) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args['name'] ?? '');
        const def = SCHEMA[name];
        if (!def) return null;
        return { __typename: '__Type', typeName: name, def };
      }
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args['input'] as Record<string, unknown>) ?? {};
        const parsed = parseGlobalId(String(input['repositoryId'] ?? ''));
        const repo = parsed?.kind === 'Repository' ? repoByDatabaseId(forge, parseInt(parsed.parts[0], 10)) : null;
        if (!repo) return { __typename: 'CreateIssuePayload', issue: null };
        const issue: IssueRec = {
          id: forge.nextId(),
          number: repo.nextNumber++,
          title: String(input['title'] ?? ''),
          body: String(input['body'] ?? ''),
          state: 'open',
          labels: [],
          createdSeq: forge.tick(),
          comments: [],
        };
        repo.issues.set(issue.number, issue);
        return { __typename: 'CreateIssuePayload', issue: wrapIssue(forge, repo, issue) };
      }
      if (field === 'closeIssue') {
        const input = (args['input'] as Record<string, unknown>) ?? {};
        const parsed = parseGlobalId(String(input['issueId'] ?? ''));
        const repo = parsed?.kind === 'Issue' ? repoByDatabaseId(forge, parseInt(parsed.parts[0], 10)) : null;
        const issue = repo?.issues.get(parseInt(parsed?.parts[1] ?? 'NaN', 10));
        if (!repo || !issue) return { __typename: 'CloseIssuePayload', issue: null };
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: wrapIssue(forge, repo, issue) };
      }
      if (field === 'createPullRequest') {
        const input = (args['input'] as Record<string, unknown>) ?? {};
        const parsed = parseGlobalId(String(input['repositoryId'] ?? ''));
        const repo = parsed?.kind === 'Repository' ? repoByDatabaseId(forge, parseInt(parsed.parts[0], 10)) : null;
        if (!repo) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        const headRef = String(input['headRefName'] ?? '');
        const baseRef = String(input['baseRefName'] ?? repo.defaultBranch);
        const headTip = repo.branchTip(headRef);
        const baseTip = repo.branchTip(baseRef);
        if (!headTip || !baseTip) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        const pr: PullRec = {
          id: forge.nextId(),
          number: repo.nextNumber++,
          title: String(input['title'] ?? ''),
          body: String(input['body'] ?? ''),
          state: 'open',
          headRef,
          baseRef,
          headShaAtCreation: headTip,
          baseShaAtCreation: baseTip,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdSeq: forge.tick(),
          comments: [],
        };
        repo.pulls.set(pr.number, pr);
        return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(forge, repo, pr) };
      }
      if (field === 'mergePullRequest') {
        const input = (args['input'] as Record<string, unknown>) ?? {};
        const parsed = parseGlobalId(String(input['pullRequestId'] ?? ''));
        const repo = parsed?.kind === 'PullRequest' ? repoByDatabaseId(forge, parseInt(parsed.parts[0], 10)) : null;
        const pr = repo?.pulls.get(parseInt(parsed?.parts[1] ?? 'NaN', 10));
        if (!repo || !pr) return { __typename: 'MergePullRequestPayload', pullRequest: null };
        squashMergePr(forge, repo, pr);
        return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(forge, repo, pr) };
      }
      if (field === 'addComment') {
        const input = (args['input'] as Record<string, unknown>) ?? {};
        const parsed = parseGlobalId(String(input['subjectId'] ?? ''));
        const body = String(input['body'] ?? '');
        let repo: Repo | null = null;
        let comment: { id: number; body: string; createdSeq: number } | null = null;
        if (parsed?.kind === 'Issue' || parsed?.kind === 'PullRequest') {
          repo = repoByDatabaseId(forge, parseInt(parsed.parts[0], 10));
          const target = parsed.kind === 'Issue'
            ? repo?.issues.get(parseInt(parsed.parts[1], 10))
            : repo?.pulls.get(parseInt(parsed.parts[1], 10));
          if (repo && target) {
            comment = { id: repo.nextCommentId++, body, createdSeq: forge.tick() };
            target.comments.push(comment);
          }
        }
        if (!repo || !comment) return { __typename: 'AddCommentPayload', commentEdge: null };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.databaseId, comment.id), body: comment.body },
            cursor: encodeCursor('ASC', comment.id),
          },
        };
      }
      return null;
    }
    case 'User':
      if (field === 'login') return String(obj['login'] ?? '');
      return null;
    case 'Repository': {
      const repo = obj['repo'] as Repo;
      if (field === 'id') return globalId('Repository', repo.databaseId);
      if (field === 'databaseId') return repo.databaseId;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${forge.ownerLogin(repo)}/${repo.name}`;
      if (field === 'owner') return { __typename: 'User', login: forge.ownerLogin(repo) };
      if (field === 'defaultBranchRef') {
        return repo.unborn ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const issue = repo.issues.get(Number(args['number']));
        return issue ? wrapIssue(forge, repo, issue) : null;
      }
      if (field === 'issues') return issueConnection(forge, repo, args);
      if (field === 'pullRequests') {
        const first = typeof args['first'] === 'number' ? args['first'] : null;
        let list = [...repo.pulls.values()].filter((pr) => pr.state === 'open');
        list.sort((a, b) => a.number - b.number);
        const page = first !== null ? list.slice(0, first) : list;
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((pr) => wrapPull(forge, repo, pr)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: first !== null && list.length > first, endCursor: null },
        };
      }
      if (field === 'pullRequest') {
        const pr = repo.pulls.get(Number(args['number']));
        return pr ? wrapPull(forge, repo, pr) : null;
      }
      return null;
    }
    case 'Ref':
      if (field === 'name') return String(obj['name'] ?? '');
      return null;
    case 'Issue': {
      const issue = obj['issue'] as IssueRec;
      const repo = obj['repo'] as Repo;
      if (field === 'id') return globalId('Issue', repo.databaseId, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'body') return issue.body;
      return null;
    }
    case 'IssueConnection':
      if (field === 'nodes') return (obj['nodes'] as GqlValue[]) ?? [];
      if (field === 'pageInfo') return obj['pageInfo'] as GqlObject;
      return null;
    case 'PageInfo':
      if (field === 'hasNextPage') return Boolean(obj['hasNextPage']);
      if (field === 'endCursor') return (obj['endCursor'] as string | null) ?? null;
      return null;
    case 'PullRequest': {
      const pr = obj['pr'] as PullRec;
      const repo = obj['repo'] as Repo;
      if (field === 'id') return globalId('PullRequest', repo.databaseId, pr.number);
      if (field === 'number') return pr.number;
      if (field === 'title') return pr.title;
      if (field === 'body') return pr.body;
      if (field === 'state') return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pr.merged;
      if (field === 'headRefName') return pr.headRef;
      if (field === 'baseRefName') return pr.baseRef;
      if (field === 'mergeable') return repo.mergeableState(pr);
      if (field === 'files') {
        const headTip = repo.branchTip(pr.headRef) ?? pr.headShaAtCreation;
        const baseTip = repo.branchTip(pr.baseRef) ?? pr.baseShaAtCreation;
        const base = mergeBase(repo.objects, baseTip, headTip);
        const files = repo.diffCommits(base, headTip);
        const first = typeof args['first'] === 'number' ? args['first'] : null;
        const page = first !== null ? files.slice(0, first) : files;
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: page.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: first !== null && files.length > first, endCursor: null },
        };
      }
      return null;
    }
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
      if (field === 'nodes') return (obj['nodes'] as GqlValue[]) ?? [];
      if (field === 'pageInfo') return obj['pageInfo'] as GqlObject;
      return null;
    case 'PullRequestChangedFile':
      if (field === 'path') return String(obj['path'] ?? '');
      return null;
    case 'IssueComment':
      if (field === 'id') return String(obj['id'] ?? '');
      if (field === 'body') return String(obj['body'] ?? '');
      return null;
    case 'IssueCommentEdge':
      if (field === 'node') return obj['node'] as GqlObject;
      if (field === 'cursor') return String(obj['cursor'] ?? '');
      return null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field === 'issue') return (obj['issue'] as GqlValue) ?? null;
      return null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return (obj['pullRequest'] as GqlValue) ?? null;
      return null;
    case 'AddCommentPayload':
      if (field === 'commentEdge') return (obj['commentEdge'] as GqlValue) ?? null;
      return null;
    case '__Type': {
      const def = obj['def'] as TypeDef;
      if (field === 'name') return String(obj['typeName'] ?? '');
      if (field === 'kind') return def.kind;
      if (field === 'fields') {
        return Object.keys(def.fields).map((name) => ({ __typename: '__Field', name }));
      }
      if (field === 'enumValues') {
        return (def.enumValues ?? []).map((name) => ({ __typename: '__EnumValue', name }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue':
      if (field === 'name') return String(obj['name'] ?? '');
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export interface GraphQLResponse {
  status: number;
  body: string;
}

function executeOne(forge: Forge, payload: Record<string, unknown>): Record<string, unknown> {
  const query = payload['query'];
  if (typeof query !== 'string') {
    return { errors: [{ message: 'query is required' }] };
  }
  const variables = (payload['variables'] as Record<string, unknown> | null | undefined) ?? {};
  const operationName = typeof payload['operationName'] === 'string' ? payload['operationName'] : null;
  let parsed;
  try {
    parsed = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Syntax Error: ${(error as Error).message}` }] };
  }
  let operation = parsed.operations[0];
  if (operationName !== null) {
    operation = parsed.operations.find((op) => op.name === operationName) ?? operation;
  }
  if (!operation) return { errors: [{ message: 'no operation found' }] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelection(rootType, operation.selection, parsed.fragments, errors, new Set());
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const ctx: ExecContext = { forge, variables, fragments: parsed.fragments };
  const root: GqlObject = { __typename: rootType };
  try {
    const data = executeSelection(root, operation.selection, ctx, operation);
    return { data };
  } catch (error) {
    return { data: null, errors: [{ message: (error as Error).message }] };
  }
}

export function handleGraphQL(forge: Forge, body: Buffer): GraphQLResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'request body must be valid JSON' }] }) };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => {
      if (item === null || typeof item !== 'object') return { errors: [{ message: 'batch item must be an object' }] };
      return executeOne(forge, item as Record<string, unknown>);
    });
    return { status: 200, body: JSON.stringify(results) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'request body must be an object' }] }) };
  }
  return { status: 200, body: JSON.stringify(executeOne(forge, parsed as Record<string, unknown>)) };
}
