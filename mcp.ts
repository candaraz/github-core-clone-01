// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP, single JSON response per
// POST. Speaks the stateless 2026-07-28 revision (server/discover, no
// sessions) and answers the legacy initialize handshake for older clients.
// Six tools share the same store as the REST and GraphQL surfaces.

import { mergeBase } from './objects.ts';
import { Forge, type IssueRec, type PullRec, type Repo } from './store.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

export interface McpResponse {
  status: number;
  body: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: { type: string } }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the current user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
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
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: "Filter by state: 'open', 'closed', or 'all'" },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Branch containing the changes' },
        base: { type: 'string', description: 'Branch to merge into' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request using a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

// ---------------------------------------------------------------------------
// Argument helpers (lenient spellings; the suite maps semantic arguments)
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function pickString(args: Args, ...names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function pickNumber(args: Args, ...names: string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  }
  return null;
}

function pickBoolean(args: Args, ...names: string[]): boolean | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function resolveOwnerRepo(forge: Forge, args: Args): { owner: string; repoName: string; repo: Repo } | null {
  let owner = pickString(args, 'owner');
  let repoName = pickString(args, 'repo', 'repository', 'repo_name');
  if ((!owner || !repoName) && typeof args['full_name'] === 'string') {
    const parts = (args['full_name'] as string).split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repoName = repoName ?? parts[1];
    }
  }
  if (!owner || !repoName) return null;
  const repo = forge.repoFor(owner, repoName);
  if (!repo) return null;
  return { owner, repoName, repo };
}

// ---------------------------------------------------------------------------
// Tool result shapes
// ---------------------------------------------------------------------------

function repoResult(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.ownerLogin(repo);
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueResult(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: forge.ownerLogin(repo) },
    created_at: forge.isoFor(issue.createdSeq),
  };
}

function pullResult(forge: Forge, repo: Repo, pr: PullRec): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: repo.branchTip(pr.headRef) ?? pr.headShaAtCreation },
    base: { ref: pr.baseRef, sha: repo.branchTip(pr.baseRef) ?? pr.baseShaAtCreation },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
  };
}

type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function runTool(forge: Forge, name: string, args: Args): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = pickString(args, 'name');
      if (!repoName) return { ok: false, message: 'name is required' };
      if (forge.hasRepo(repoName)) return { ok: false, message: 'name already exists on this account' };
      const repo = forge.createRepo(repoName, pickString(args, 'description') ?? '', pickBoolean(args, 'private') ?? false);
      return { ok: true, value: repoResult(forge, repo) };
    }
    case 'get_repo': {
      const resolved = resolveOwnerRepo(forge, args);
      if (!resolved) return { ok: false, message: 'repository not found' };
      return { ok: true, value: repoResult(forge, resolved.repo) };
    }
    case 'create_issue': {
      const resolved = resolveOwnerRepo(forge, args);
      if (!resolved) return { ok: false, message: 'repository not found' };
      const title = pickString(args, 'title');
      if (!title) return { ok: false, message: 'title is required' };
      const labels: string[] = [];
      const rawLabels = args['labels'];
      if (Array.isArray(rawLabels)) {
        for (const raw of rawLabels) {
          if (typeof raw !== 'string') continue;
          if (!resolved.repo.labels.has(raw)) return { ok: false, message: `Label '${raw}' does not exist` };
          labels.push(raw);
        }
      }
      const issue: IssueRec = {
        id: forge.nextId(),
        number: resolved.repo.nextNumber++,
        title,
        body: pickString(args, 'body') ?? '',
        state: 'open',
        labels,
        createdSeq: forge.tick(),
        comments: [],
      };
      resolved.repo.issues.set(issue.number, issue);
      return { ok: true, value: issueResult(forge, resolved.repo, issue) };
    }
    case 'list_issues': {
      const resolved = resolveOwnerRepo(forge, args);
      if (!resolved) return { ok: false, message: 'repository not found' };
      const state = (pickString(args, 'state') ?? 'open').toLowerCase();
      let list = [...resolved.repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return { ok: true, value: list.map((issue) => issueResult(forge, resolved.repo, issue)) };
    }
    case 'create_pull_request': {
      const resolved = resolveOwnerRepo(forge, args);
      if (!resolved) return { ok: false, message: 'repository not found' };
      const title = pickString(args, 'title');
      if (!title) return { ok: false, message: 'title is required' };
      let headRef = pickString(args, 'head') ?? '';
      const colon = headRef.indexOf(':');
      if (colon !== -1) headRef = headRef.slice(colon + 1);
      const baseRef = pickString(args, 'base') ?? resolved.repo.defaultBranch;
      const headTip = resolved.repo.branchTip(headRef);
      if (!headTip) return { ok: false, message: 'head branch does not exist' };
      const baseTip = resolved.repo.branchTip(baseRef);
      if (!baseTip) return { ok: false, message: 'base branch does not exist' };
      const pr: PullRec = {
        id: forge.nextId(),
        number: resolved.repo.nextNumber++,
        title,
        body: pickString(args, 'body') ?? '',
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
      resolved.repo.pulls.set(pr.number, pr);
      return { ok: true, value: pullResult(forge, resolved.repo, pr) };
    }
    case 'merge_pull_request': {
      const resolved = resolveOwnerRepo(forge, args);
      if (!resolved) return { ok: false, message: 'repository not found' };
      const number = pickNumber(args, 'pull_number', 'pullNumber', 'pull_request_number', 'pr_number', 'number', 'issue_number');
      if (number === null) return { ok: false, message: 'pull_number is required' };
      const pr = resolved.repo.pulls.get(number);
      if (!pr) return { ok: false, message: 'pull request not found' };
      if (pr.merged || pr.state !== 'open') return { ok: false, message: 'pull request is already merged or closed' };
      const headTip = resolved.repo.branchTip(pr.headRef) ?? pr.headShaAtCreation;
      const baseTip = resolved.repo.branchTip(pr.baseRef) ?? pr.baseShaAtCreation;
      const base = mergeBase(resolved.repo.objects, baseTip, headTip);
      const { merged, conflicts } = resolved.repo.threeWayMerge(base, baseTip, headTip);
      if (conflicts.length > 0) return { ok: false, message: 'merge conflict' };
      const seq = forge.tick();
      const sha = resolved.repo.commitOnBranch(pr.baseRef, merged, `Squash merge #${pr.number}: ${pr.title}`, forge.epochFor(seq));
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = forge.isoFor(seq);
      pr.mergeCommitSha = sha;
      return { ok: true, value: { merged: true, sha, number: pr.number, message: 'Pull Request successfully merged' } };
    }
    default:
      return { ok: false, message: `unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

export function handleMcp(forge: Forge, method: string, body: Buffer): McpResponse {
  if (method !== 'POST') {
    return { status: 405, body: '' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body must be valid JSON' } }),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request must be a JSON-RPC object' } }),
    };
  }
  const request = parsed as Record<string, unknown>;
  const hasId = 'id' in request;
  const id = request['id'] ?? null;
  const rpcMethod = request['method'];

  // Notifications (no id) are acknowledged with 202 and no JSON-RPC response.
  if (!hasId) {
    return { status: 202, body: '' };
  }
  if (typeof rpcMethod !== 'string') {
    return rpcError(id, -32600, 'Invalid Request: method must be a string');
  }

  switch (rpcMethod) {
    case 'server/discover': {
      const info = serverInfo();
      return rpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: info,
        _meta: { 'io.modelcontextprotocol/serverInfo': info },
      });
    }
    case 'initialize': {
      const params = (request['params'] as Record<string, unknown> | undefined) ?? {};
      const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (request['params'] as Record<string, unknown> | undefined) ?? {};
      const toolName = params['name'];
      if (typeof toolName !== 'string') {
        return rpcError(id, -32602, 'Invalid params: name is required');
      }
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        return rpcError(id, -32601, `Method not found: ${toolName}`);
      }
      const args = (params['arguments'] as Args | undefined) ?? {};
      let outcome: ToolOutcome;
      try {
        outcome = runTool(forge, toolName, args);
      } catch (error) {
        outcome = { ok: false, message: (error as Error).message };
      }
      if (!outcome.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: outcome.message }],
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value, null, 2) }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${rpcMethod}`);
  }
}
