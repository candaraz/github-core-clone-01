// GraphQL: a small real lexer, parser and executor over the forge's fixed schema.
//
// The suite sends eighteen fixed documents (plus aliases, inline fragments, variables, inline
// input objects, enum lists, null variables, operation names and batched arrays), so this is a
// genuine GraphQL implementation for one schema — not string matching. Unknown fields are
// errors (HTTP 200, `data: null`, an `errors` array naming the field); unknown repositories
// resolve to null without errors. Mutations share the REST store and are cross-checked by the
// suite through REST, so they perform exactly the REST operations.

import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';

// --------------------------------------------------------------------------- lexer

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '$', '=', '@', '&', '|']);

function lex(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF' || ch === '\u00A0') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source[i + 1] === '"' && source[i + 2] === '"') {
        // Block string: raw until the closing triple quote.
        let j = i + 3;
        while (j < n && !(source[j] === '"' && source[j + 1] === '"' && source[j + 2] === '"')) j += 1;
        tokens.push({ kind: 'string', value: source.slice(i + 3, j) });
        i = Math.min(j + 3, n);
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < n) {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u' && j + 5 < n) {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = Math.min(j + 1, n);
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expectPunct(value) {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Syntax Error: expected "${value}" but got ${JSON.stringify(token.value)}`);
    }
  }

  expectName(value) {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Syntax Error: expected name ${value ?? ''} but got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  skipDirectives() {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  parseDefinition() {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value;
      let name = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.peek().kind === 'punct' && this.peek().value === '('
        ? this.parseVariableDefinitions()
        : [];
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`Syntax Error: unexpected token ${JSON.stringify(token.value)}`);
  }

  parseVariableDefinitions() {
    const definitions = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      definitions.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  parseType() {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  parseSelectionSet() {
    const selections = [];
    this.expectPunct('{');
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection() {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let alias = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{'
      ? this.parseSelectionSet()
      : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  parseArguments() {
    const args = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue() {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`Syntax Error: unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// --------------------------------------------------------------------------- values

const TYPE = Symbol('graphql-type');

function tag(type, object) {
  if (object !== null && typeof object === 'object') object[TYPE] = type;
  return object;
}

function typeOf(value) {
  if (value !== null && typeof value === 'object') return value[TYPE] ?? null;
  return null;
}

function evalValue(node, variables) {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((item) => evalValue(item, variables));
    case 'object': {
      const object = {};
      for (const field of node.fields) object[field.name] = evalValue(field.value, variables);
      return object;
    }
    default:
      return null;
  }
}

/** Evaluate arguments; a null-valued variable counts as an absent argument. */
function evalArgs(argNodes, variables) {
  const args = {};
  for (const arg of argNodes) {
    const value = evalValue(arg.value, variables);
    if (value !== null) args[arg.name] = value;
  }
  return args;
}

// --------------------------------------------------------------------------- ids and cursors

function repoGlobalId(repo) {
  return `R${repo.id}`;
}
function issueGlobalId(repo, issue) {
  return `I${repo.id}_${issue.number}`;
}
function prGlobalId(repo, pr) {
  return `P${repo.id}_${pr.number}`;
}
function commentGlobalId(repo, comment) {
  return `C${repo.id}_${comment.id}`;
}

function parseGlobalId(id) {
  if (typeof id !== 'string') return null;
  const match = /^([RIPCU])(\d+)(?:_(\d+))?$/.exec(id);
  if (match === null) return null;
  return { kind: match[1], dbId: Number(match[2]), num: match[3] === undefined ? null : Number(match[3]) };
}

function findRepoByDbId(store, dbId) {
  for (const repo of store.repos.values()) {
    if (repo.id === dbId) return repo;
  }
  return null;
}

function findSubjectById(store, id) {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const repo = findRepoByDbId(store, parsed.dbId);
  if (repo === null) return null;
  if (parsed.kind === 'R') return { kind: 'repo', repo };
  if (parsed.kind === 'I') {
    const issue = repo.issues.get(parsed.num);
    return issue === undefined ? null : { kind: 'issue', repo, record: issue };
  }
  if (parsed.kind === 'P') {
    const pr = repo.pulls.get(parsed.num);
    return pr === undefined ? null : { kind: 'pr', repo, record: pr };
  }
  if (parsed.kind === 'C') {
    for (const issue of repo.issues.values()) {
      const comment = issue.comments.find((item) => item.id === parsed.num);
      if (comment !== undefined) return { kind: 'comment', repo, record: comment };
    }
    for (const pr of repo.pulls.values()) {
      const comment = pr.comments.find((item) => item.id === parsed.num);
      if (comment !== undefined) return { kind: 'comment', repo, record: comment };
    }
    return null;
  }
  return null;
}

function cursorFor(key) {
  return Buffer.from(`c:${key}`, 'utf8').toString('base64');
}

function cursorKey(cursor) {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    return text.startsWith('c:') ? text.slice(2) : null;
  } catch {
    return null;
  }
}

function isoSec(sec) {
  return new Date(sec * 1000).toISOString();
}

// --------------------------------------------------------------------------- connections

function connection(items, args, typeName, edgeType, keyOf) {
  let start = 0;
  if (args.after !== undefined) {
    const key = cursorKey(args.after);
    if (key !== null) {
      const index = items.findIndex((item) => keyOf(item) === key);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const slice = items.slice(start, start + Math.max(0, first));
  const edges = slice.map((node) => tag(edgeType, { node, cursor: cursorFor(keyOf(node)) }));
  const pageInfo = tag('PageInfo', {
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: edges.length > 0 ? edges[0].cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
  });
  return tag(typeName, { nodes: slice, edges, pageInfo, totalCount: items.length });
}

function orderItems(items, orderBy, keyOf) {
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  const stamp = (item) => {
    if (field === 'UPDATED_AT') return item.updatedSec;
    if (field === 'COMMENTS') return item.comments.length;
    return item.createdSec;
  };
  return items.slice().sort((a, b) => {
    const diff = stamp(a) - stamp(b);
    if (diff !== 0) return diff * direction;
    return (keyOf(a) - keyOf(b)) * direction;
  });
}

// --------------------------------------------------------------------------- resolvers

function viewerUser() {
  return tag('User', { login: VIEWER.login, id: `U${VIEWER.id}`, databaseId: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
}

function issueNode(repo, issue) {
  return tag('Issue', { repo, record: issue });
}

function prNode(repo, pr) {
  return tag('PullRequest', { repo, record: pr });
}

function commentNode(repo, comment) {
  return tag('IssueComment', { repo, record: comment });
}

function repoNode(repo) {
  return tag('Repository', { repo });
}

const RESOLVERS = {
  Query: {
    viewer: () => viewerUser(),
    repository: (parent, args, ctx) => {
      if (args.owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(args.owner, args.name);
      return repo === undefined ? null : repoNode(repo);
    },
    node: (parent, args, ctx) => {
      const found = findSubjectById(ctx.store, args.id);
      if (found === null) return null;
      if (found.kind === 'repo') return repoNode(found.repo);
      if (found.kind === 'issue') return issueNode(found.repo, found.record);
      if (found.kind === 'pr') return prNode(found.repo, found.record);
      if (found.kind === 'comment') return commentNode(found.repo, found.record);
      return null;
    },
    __type: (parent, args) => introspectType(args.name),
    __schema: () => tag('__Schema', {}),
  },

  Mutation: {
    createIssue: (parent, args, ctx) => {
      const input = args.input ?? {};
      const found = findSubjectById(ctx.store, input.repositoryId);
      let issue = null;
      if (found !== null && found.kind === 'repo') {
        const repo = found.repo;
        const now = ctx.store.tick();
        issue = {
          id: ctx.store.nextGlobalId++,
          number: repo.nextNumber++,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          createdSec: now,
          updatedSec: now,
          closedSec: null,
          comments: [],
        };
        repo.issues.set(issue.number, issue);
        repo.bump();
      }
      return tag('CreateIssuePayload', {
        issue: issue === null ? null : issueNode(found.repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
    closeIssue: (parent, args, ctx) => {
      const input = args.input ?? {};
      const found = findSubjectById(ctx.store, input.issueId);
      let issue = null;
      if (found !== null && found.kind === 'issue') {
        issue = found.record;
        issue.state = 'closed';
        issue.closedSec = ctx.store.tick();
        issue.updatedSec = issue.closedSec;
        found.repo.bump();
      }
      return tag('CloseIssuePayload', {
        issue: issue === null ? null : issueNode(found.repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
    createPullRequest: (parent, args, ctx) => {
      const input = args.input ?? {};
      const found = findSubjectById(ctx.store, input.repositoryId);
      let pr = null;
      if (found !== null && found.kind === 'repo') {
        const repo = found.repo;
        const head = input.headRefName;
        const base = input.baseRefName;
        if (repo.refs.get(`refs/heads/${head}`) !== undefined && repo.refs.get(`refs/heads/${base}`) !== undefined) {
          const now = ctx.store.tick();
          pr = {
            id: ctx.store.nextGlobalId++,
            number: repo.nextNumber++,
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            headRef: head,
            baseRef: base,
            createdSec: now,
            updatedSec: now,
            closedSec: null,
            merged: false,
            mergedAtSec: null,
            mergeCommitSha: null,
            comments: [],
            labels: [],
          };
          repo.pulls.set(pr.number, pr);
          repo.bump();
        }
      }
      return tag('CreatePullRequestPayload', {
        pullRequest: pr === null ? null : prNode(found.repo, pr),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
    mergePullRequest: (parent, args, ctx) => {
      const input = args.input ?? {};
      const found = findSubjectById(ctx.store, input.pullRequestId);
      let pr = null;
      if (found !== null && found.kind === 'pr') {
        pr = found.record;
        if (!pr.merged) {
          const result = found.repo.squashMerge(pr, ctx.store, pr.title);
          if (result.conflict !== true) {
            found.repo.refs.set(`refs/heads/${pr.baseRef}`, result.oid);
            const now = ctx.store.tick();
            pr.merged = true;
            pr.state = 'closed';
            pr.closedSec = now;
            pr.mergedAtSec = now;
            pr.mergeCommitSha = result.oid;
            pr.updatedSec = now;
            found.repo.bump();
          }
        }
      }
      return tag('MergePullRequestPayload', {
        pullRequest: pr === null ? null : prNode(found.repo, pr),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
    addComment: (parent, args, ctx) => {
      const input = args.input ?? {};
      const found = findSubjectById(ctx.store, input.subjectId);
      let comment = null;
      let repo = null;
      if (found !== null && (found.kind === 'issue' || found.kind === 'pr')) {
        repo = found.repo;
        const now = ctx.store.tick();
        comment = {
          id: ctx.store.nextGlobalId++,
          body: typeof input.body === 'string' ? input.body : '',
          createdSec: now,
          updatedSec: now,
        };
        found.record.comments.push(comment);
        repo.bump();
      }
      return tag('AddCommentPayload', {
        commentEdge: comment === null ? null : tag('IssueCommentEdge', {
          node: commentNode(repo, comment),
          cursor: cursorFor(String(comment.id)),
        }),
        clientMutationId: input.clientMutationId ?? null,
      });
    },
  },

  Repository: {
    id: (parent) => repoGlobalId(parent.repo),
    databaseId: (parent) => parent.repo.id,
    name: (parent) => parent.repo.name,
    nameWithOwner: (parent) => `${parent.repo.owner}/${parent.repo.name}`,
    description: (parent) => parent.repo.description,
    isPrivate: (parent) => parent.repo.isPrivate,
    owner: () => viewerUser(),
    defaultBranchRef: (parent) => {
      if (parent.repo.headTip() === undefined) return null;
      return tag('Ref', { repo: parent.repo, name: DEFAULT_BRANCH });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (parent) => isoSec(parent.repo.createdSec),
    updatedAt: (parent) => isoSec(parent.repo.updatedSec),
    url: (parent) => `https://github.com/${parent.repo.owner}/${parent.repo.name}`,
    resourcePath: (parent) => `/${parent.repo.owner}/${parent.repo.name}`,
    issue: (parent, args) => {
      const issue = parent.repo.issues.get(args.number);
      return issue === undefined ? null : issueNode(parent.repo, issue);
    },
    issues: (parent, args) => {
      let issues = [...parent.repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const ordered = orderItems(issues, args.orderBy, (issue) => issue.number);
      const nodes = ordered.map((issue) => issueNode(parent.repo, issue));
      return connection(nodes, args, 'IssueConnection', 'IssueEdge', (node) => String(node.record.number));
    },
    pullRequest: (parent, args) => {
      const pr = parent.repo.pulls.get(args.number);
      return pr === undefined ? null : prNode(parent.repo, pr);
    },
    pullRequests: (parent, args) => {
      let prs = [...parent.repo.pulls.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((state) => String(state)));
        prs = prs.filter((pr) => wanted.has(prState(pr)));
      }
      const ordered = orderItems(prs, args.orderBy, (pr) => pr.number);
      const nodes = ordered.map((pr) => prNode(parent.repo, pr));
      return connection(nodes, args, 'PullRequestConnection', 'PullRequestEdge', (node) => String(node.record.number));
    },
  },

  Issue: {
    id: (parent) => issueGlobalId(parent.repo, parent.record),
    databaseId: (parent) => parent.record.number,
    number: (parent) => parent.record.number,
    title: (parent) => parent.record.title,
    body: (parent) => parent.record.body,
    state: (parent) => (parent.record.state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (parent) => parent.record.state !== 'open',
    locked: () => false,
    author: () => viewerUser(),
    createdAt: (parent) => isoSec(parent.record.createdSec),
    updatedAt: (parent) => isoSec(parent.record.updatedSec),
    closedAt: (parent) => (parent.record.closedSec === null ? null : isoSec(parent.record.closedSec)),
    url: (parent) => `https://github.com/${parent.repo.owner}/${parent.repo.name}/issues/${parent.record.number}`,
    resourcePath: (parent) => `/${parent.repo.owner}/${parent.repo.name}/issues/${parent.record.number}`,
    viewerDidAuthor: () => true,
    comments: (parent, args) => {
      const nodes = parent.record.comments.map((comment) => commentNode(parent.repo, comment));
      return connection(nodes, args, 'IssueCommentConnection', 'IssueCommentEdge', (node) => String(node.record.id));
    },
    labels: (parent, args) => {
      const nodes = parent.record.labels.map((name) => {
        const label = parent.repo.labels.get(name);
        return tag('Label', { name, color: label?.color ?? '000000', repo: parent.repo });
      });
      return connection(nodes, args, 'LabelConnection', 'LabelEdge', (node) => node.name);
    },
  },

  PullRequest: {
    id: (parent) => prGlobalId(parent.repo, parent.record),
    databaseId: (parent) => parent.record.number,
    number: (parent) => parent.record.number,
    title: (parent) => parent.record.title,
    body: (parent) => parent.record.body,
    state: (parent) => prState(parent.record),
    merged: (parent) => parent.record.merged,
    mergeable: (parent) => {
      if (parent.record.state !== 'open') return 'UNKNOWN';
      return parent.repo.mergeWouldConflict(parent.record) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (parent) => parent.record.headRef,
    baseRefName: (parent) => parent.record.baseRef,
    headRefOid: (parent) => parent.repo.refs.get(`refs/heads/${parent.record.headRef}`) ?? null,
    baseRefOid: (parent) => parent.repo.refs.get(`refs/heads/${parent.record.baseRef}`) ?? null,
    headRef: (parent) => tag('Ref', { repo: parent.repo, name: parent.record.headRef }),
    baseRef: (parent) => tag('Ref', { repo: parent.repo, name: parent.record.baseRef }),
    isDraft: () => false,
    author: () => viewerUser(),
    createdAt: (parent) => isoSec(parent.record.createdSec),
    updatedAt: (parent) => isoSec(parent.record.updatedSec),
    closedAt: (parent) => (parent.record.closedSec === null ? null : isoSec(parent.record.closedSec)),
    mergedAt: (parent) => (parent.record.mergedAtSec === null ? null : isoSec(parent.record.mergedAtSec)),
    url: (parent) => `https://github.com/${parent.repo.owner}/${parent.repo.name}/pull/${parent.record.number}`,
    resourcePath: (parent) => `/${parent.repo.owner}/${parent.repo.name}/pull/${parent.record.number}`,
    files: (parent, args) => {
      const files = parent.repo.prFiles(parent.record);
      const nodes = files.map((file, index) => tag('PullRequestChangedFile', {
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        index,
      }));
      return connection(nodes, args, 'PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', (node) => String(node.index));
    },
    comments: (parent, args) => {
      const nodes = parent.record.comments.map((comment) => commentNode(parent.repo, comment));
      return connection(nodes, args, 'IssueCommentConnection', 'IssueCommentEdge', (node) => String(node.record.id));
    },
  },

  User: {
    id: (parent) => parent.id,
    databaseId: (parent) => parent.databaseId,
    login: (parent) => parent.login,
    name: (parent) => parent.name,
    email: (parent) => parent.email,
    url: (parent) => `https://github.com/${parent.login}`,
    resourcePath: (parent) => `/${parent.login}`,
  },

  Ref: {
    name: (parent) => parent.name,
    target: (parent) => {
      const oid = parent.repo.refs.get(`refs/heads/${parent.name}`);
      if (oid === undefined) return null;
      const peeled = parent.repo.peelToCommit(oid);
      if (peeled === null) return null;
      const commit = parent.repo.commitOf(peeled);
      return tag('Commit', {
        oid: peeled,
        message: commit === null ? '' : commit.message.replace(/\n$/, ''),
      });
    },
  },

  Commit: {
    oid: (parent) => parent.oid,
    abbreviatedOid: (parent) => parent.oid.slice(0, 7),
    message: (parent) => parent.message,
  },

  IssueComment: {
    id: (parent) => commentGlobalId(parent.repo, parent.record),
    databaseId: (parent) => parent.record.id,
    body: (parent) => parent.record.body,
    bodyText: (parent) => parent.record.body,
    author: () => viewerUser(),
    createdAt: (parent) => isoSec(parent.record.createdSec),
    updatedAt: (parent) => isoSec(parent.record.updatedSec),
  },

  Label: {
    id: (parent) => `L${parent.repo.id}_${parent.name}`,
    name: (parent) => parent.name,
    color: (parent) => parent.color,
  },

  PullRequestChangedFile: {
    path: (parent) => parent.path,
    additions: (parent) => parent.additions,
    deletions: (parent) => parent.deletions,
    changeType: (parent) => parent.changeType,
  },

  IssueConnection: connectionResolvers(),
  PullRequestConnection: connectionResolvers(),
  IssueCommentConnection: connectionResolvers(),
  LabelConnection: connectionResolvers(),
  PullRequestChangedFileConnection: connectionResolvers(),

  IssueEdge: edgeResolvers(),
  PullRequestEdge: edgeResolvers(),
  IssueCommentEdge: edgeResolvers(),
  LabelEdge: edgeResolvers(),
  PullRequestChangedFileEdge: edgeResolvers(),

  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    startCursor: (parent) => parent.startCursor,
    endCursor: (parent) => parent.endCursor,
  },

  CreateIssuePayload: {
    issue: (parent) => parent.issue,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
    clientMutationId: (parent) => parent.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge,
    clientMutationId: (parent) => parent.clientMutationId,
  },

  __Type: {
    name: (parent) => parent.name,
    kind: (parent) => parent.kind,
    description: () => null,
    fields: (parent) => (parent.fields ?? []).map((name) => tag('__Field', { name })),
    enumValues: (parent) => (parent.enumValues ?? []).map((name) => tag('__EnumValue', { name })),
    inputFields: () => [],
  },
  __Field: {
    name: (parent) => parent.name,
    description: () => null,
    args: () => [],
    type: () => tag('__Type', { name: 'String', kind: 'SCALAR', fields: [], enumValues: [] }),
  },
  __EnumValue: {
    name: (parent) => parent.name,
    description: () => null,
  },
  __Schema: {
    queryType: () => tag('__Type', { name: 'Query', kind: 'OBJECT', fields: Object.keys(RESOLVERS.Query), enumValues: [] }),
    mutationType: () => tag('__Type', { name: 'Mutation', kind: 'OBJECT', fields: Object.keys(RESOLVERS.Mutation), enumValues: [] }),
    subscriptionType: () => null,
  },
};

function connectionResolvers() {
  return {
    nodes: (parent) => parent.nodes,
    edges: (parent) => parent.edges,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  };
}

function edgeResolvers() {
  return {
    node: (parent) => parent.node,
    cursor: (parent) => parent.cursor,
  };
}

function prState(pr) {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

// --------------------------------------------------------------------------- introspection

const ENUM_TYPES = {
  SearchType: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['CLOSED', 'OPEN'],
  PullRequestState: ['CLOSED', 'MERGED', 'OPEN'],
  PullRequestMergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  PullRequestChangeType: ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'],
  OrderDirection: ['ASC', 'DESC'],
};

function introspectType(name) {
  if (typeof name !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(ENUM_TYPES, name)) {
    return tag('__Type', { name, kind: 'ENUM', fields: [], enumValues: ENUM_TYPES[name] });
  }
  if (Object.prototype.hasOwnProperty.call(RESOLVERS, name)) {
    return tag('__Type', { name, kind: 'OBJECT', fields: Object.keys(RESOLVERS[name]), enumValues: [] });
  }
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID' || name === 'Float') {
    return tag('__Type', { name, kind: 'SCALAR', fields: [], enumValues: [] });
  }
  return null;
}

// --------------------------------------------------------------------------- executor

class FieldError extends Error {}

function resolveSelectionSet(selections, parentType, parentValue, ctx, depth) {
  if (depth > 50) throw new FieldError('selection nesting too deep');
  if (parentValue === null || parentValue === undefined) return null;
  const result = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) throw new FieldError(`Unknown fragment "${selection.name}".`);
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(result, resolveSelectionSet(fragment.selectionSet, parentType, parentValue, ctx, depth + 1));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(result, resolveSelectionSet(selection.selectionSet, parentType, parentValue, ctx, depth + 1));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      result[key] = parentType;
      continue;
    }
    const table = RESOLVERS[parentType];
    const resolver = table?.[selection.name];
    if (resolver === undefined) {
      throw new FieldError(`Cannot query field "${selection.name}" on type "${parentType}".`);
    }
    const args = evalArgs(selection.args, ctx.variables);
    const value = resolver(parentValue, args, ctx);
    result[key] = completeValue(value, selection.selectionSet, ctx, depth + 1);
  }
  return result;
}

function completeValue(value, selectionSet, ctx, depth) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, selectionSet, ctx, depth));
  }
  if (typeof value === 'object') {
    const valueType = typeOf(value);
    // A valid document always selects sub-fields on object values; without a selection set
    // there is nothing safe to serialize from the internal record, so answer empty.
    if (selectionSet === null) return valueType === null ? value : {};
    if (valueType === null) return value;
    return resolveSelectionSet(selectionSet, valueType, value, ctx, depth);
  }
  return value;
}

function executeOperation(operation, variables, fragments, store) {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const ctx = { store, variables, fragments, root: tag(rootType, {}) };
  const data = resolveSelectionSet(operation.selectionSet, rootType, ctx.root, ctx, 0);
  return { data };
}

function executeDocument(source, variables, operationName, store) {
  const definitions = new Parser(lex(source)).parseDocument();
  const fragments = new Map();
  const operations = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation = null;
  if (operationName !== undefined && operationName !== null) {
    operation = operations.find((item) => item.name === operationName) ?? null;
    if (operation === null) throw new FieldError(`Unknown operation named "${operationName}".`);
  } else if (operations.length === 1) {
    operation = operations[0];
  } else if (operations.length > 1) {
    operation = operations[0];
  }
  if (operation === null) throw new FieldError('No operation found in document.');
  const mergedVariables = { ...(variables ?? {}) };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue !== undefined) {
      mergedVariables[variable.name] = evalValue(variable.defaultValue, mergedVariables);
    }
  }
  return executeOperation(operation, mergedVariables, fragments, store);
}

// --------------------------------------------------------------------------- handler

export function handleGraphQL(ctx) {
  if (ctx.method !== 'POST') {
    return { status: 404, json: { message: 'Not Found' } };
  }
  let payload;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, json: { message: 'invalid JSON body' } };
  }
  const runOne = (envelope) => {
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.query !== 'string') {
      return { data: null, errors: [{ message: 'Request must include a query string.' }] };
    }
    try {
      return executeDocument(envelope.query, envelope.variables ?? {}, envelope.operationName, ctx.store);
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'execution failed' }] };
    }
  };
  if (Array.isArray(payload)) {
    return { status: 200, json: payload.map(runOne) };
  }
  return { status: 200, json: runOne(payload) };
}
