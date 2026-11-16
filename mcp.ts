// MCP: JSON-RPC 2.0 Streamable HTTP with plain JSON answers (no SSE), the modern
// `server/discover` era plus the `initialize` fallback. Exactly six tools, sharing the REST
// store and serializers so MCP and REST can never disagree about an id or a state.
//
// Error discipline: unknown methods are JSON-RPC -32601, missing arguments -32602, malformed
// JSON is HTTP 400 with -32700 — all HTTP 200 otherwise, never 500. Tool-level failures
// (unknown repository, merge conflict) are results with isError: true, not protocol errors.
// Notifications (requests without an id) are answered HTTP 202 with an empty body, and the
// server never hands out session ids.

import { repoJson, issueRecordJson, prRecordJson } from './rest.ts';
import { VIEWER } from './scenario.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const FALLBACK_REVISION = '2025-11-25';
const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;

// The tool list is one constant object: tools/list answers are byte-identical across calls.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// --------------------------------------------------------------------------- results

function toolResult(value) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolFailure(message) {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || value === null) {
    throw new RpcError(-32602, `missing required argument: ${name}`);
  }
  return value;
}

function requireRepo(store, owner, repoName) {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

// --------------------------------------------------------------------------- tools

const TOOL_HANDLERS = {
  create_repo: (store, args) => {
    const name = requireArg(args, 'name');
    if (typeof name !== 'string' || name === '') throw new RpcError(-32602, 'name must be a non-empty string');
    if (store.getRepo(VIEWER.login, name) !== undefined) {
      return toolFailure(`repository ${name} already exists`);
    }
    const repo = store.createRepo(name, {
      description: typeof args.description === 'string' ? args.description : '',
      isPrivate: args.private === true,
    });
    return toolResult(repoJson(store, repo));
  },

  get_repo: (store, args) => {
    const owner = requireArg(args, 'owner');
    const repoName = requireArg(args, 'repo');
    const repo = requireRepo(store, owner, repoName);
    if (repo === null) return toolFailure('repository not found');
    return toolResult(repoJson(store, repo));
  },

  create_issue: (store, args) => {
    const owner = requireArg(args, 'owner');
    const repoName = requireArg(args, 'repo');
    const title = requireArg(args, 'title');
    const repo = requireRepo(store, owner, repoName);
    if (repo === null) return toolFailure('repository not found');
    const now = store.tick();
    const issue = {
      id: store.nextGlobalId++,
      number: repo.nextNumber++,
      title: typeof title === 'string' ? title : String(title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      createdSec: now,
      updatedSec: now,
      closedSec: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    repo.bump();
    return toolResult(issueRecordJson(store, repo, issue, false));
  },

  list_issues: (store, args) => {
    const owner = requireArg(args, 'owner');
    const repoName = requireArg(args, 'repo');
    const repo = requireRepo(store, owner, repoName);
    if (repo === null) return toolFailure('repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => b.createdSec - a.createdSec || b.number - a.number);
    return toolResult(issues.map((issue) => issueRecordJson(store, repo, issue, false)));
  },

  create_pull_request: (store, args) => {
    const owner = requireArg(args, 'owner');
    const repoName = requireArg(args, 'repo');
    const title = requireArg(args, 'title');
    const head = requireArg(args, 'head');
    const base = requireArg(args, 'base');
    const repo = requireRepo(store, owner, repoName);
    if (repo === null) return toolFailure('repository not found');
    if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
      return toolFailure('head or base branch not found');
    }
    const now = store.tick();
    const pr = {
      id: store.nextGlobalId++,
      number: repo.nextNumber++,
      title: typeof title === 'string' ? title : String(title),
      body: typeof args.body === 'string' ? args.body : '',
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
    return toolResult(prRecordJson(store, repo, pr));
  },

  merge_pull_request: (store, args) => {
    const owner = requireArg(args, 'owner');
    const repoName = requireArg(args, 'repo');
    const rawNumber = requireArg(args, 'pull_number');
    const number = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
    if (!Number.isInteger(number) || number < 1) throw new RpcError(-32602, 'pull_number must be a positive integer');
    const repo = requireRepo(store, owner, repoName);
    if (repo === null) return toolFailure('repository not found');
    const pr = repo.pulls.get(number);
    if (pr === undefined) return toolFailure('pull request not found');
    if (pr.merged) return toolFailure('pull request already merged');
    const result = repo.squashMerge(pr, store, pr.title);
    if (result.conflict === true) return toolFailure('merge conflict');
    repo.refs.set(`refs/heads/${pr.baseRef}`, result.oid);
    const now = store.tick();
    pr.merged = true;
    pr.state = 'closed';
    pr.closedSec = now;
    pr.mergedAtSec = now;
    pr.mergeCommitSha = result.oid;
    pr.updatedSec = now;
    repo.bump();
    return toolResult({ sha: result.oid, merged: true, message: 'Pull Request successfully merged' });
  },
};

// --------------------------------------------------------------------------- dispatch

function dispatch(store, request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const hasId = request.id !== undefined && request.id !== null;
  const method = request.method;
  if (typeof method !== 'string') {
    if (!hasId) return null; // notification with no method: nothing to answer
    return { jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'Invalid Request' } };
  }
  // Notifications (no id) never receive a response.
  if (!hasId) return null;
  const id = request.id;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'server/discover') {
    return ok({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const params = request.params ?? {};
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = REVISION_RE.test(offered) ? offered : FALLBACK_REVISION;
    return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') {
    return ok({});
  }
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = request.params ?? {};
    const name = params.name;
    if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
      return fail(-32601, `unknown tool: ${String(name)}`);
    }
    const args = params.arguments ?? {};
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return fail(-32602, 'arguments must be an object');
    }
    try {
      return ok(TOOL_HANDLERS[name](store, args));
    } catch (error) {
      if (error instanceof RpcError) return fail(error.code, error.message);
      return fail(-32603, 'tool execution failed');
    }
  }
  return fail(-32601, `method not found: ${method}`);
}

export function handleMcp(ctx) {
  if (ctx.method !== 'POST') {
    return { status: 404, json: { message: 'Not Found' } };
  }
  let payload;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(payload)) {
    const responses = [];
    for (const request of payload) {
      const response = dispatch(ctx.store, request);
      if (response !== null) responses.push(response);
    }
    return { status: 200, json: responses };
  }
  const response = dispatch(ctx.store, payload);
  if (response === null) return { status: 202, json: null };
  return { status: 200, json: response };
}
