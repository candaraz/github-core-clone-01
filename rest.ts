// GitHub REST API v3 surface: repos, branches, commits, contents, labels,
// issues, comments, pull requests. Shapes follow the GitHub REST API; every
// reply is JSON with a request id (added by the router).

import { mergeBase, parseCommit, parseTree } from './objects.ts';
import { Forge, globalId, type IssueRec, type PullRec, type Repo } from './store.ts';

export interface RestContext {
  method: string;
  segments: string[];
  query: URLSearchParams;
  host: string;
  body: Buffer;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RestResponse {
  return { status, headers, body: JSON.stringify(value) };
}

function failure(status: number, message: string): RestResponse {
  return json(status, { message });
}

function parseBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: 1, type: 'User', site_admin: false };
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.ownerLogin(repo);
  const created = forge.isoFor(repo.createdSeq);
  return {
    id: repo.databaseId,
    node_id: globalId('Repository', repo.databaseId),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userJson(owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: created,
    updated_at: created,
    pushed_at: created,
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
  };
}

function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  const created = forge.isoFor(issue.createdSeq);
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.databaseId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: userJson(forge.ownerLogin(repo)),
    comments: issue.comments.length,
    created_at: created,
    updated_at: created,
    closed_at: issue.state === 'closed' ? created : null,
    html_url: `https://github.com/${forge.ownerLogin(repo)}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pr: PullRec): Record<string, unknown> {
  const created = forge.isoFor(pr.createdSeq);
  const headSha = repo.branchTip(pr.headRef) ?? pr.headShaAtCreation;
  const baseSha = repo.branchTip(pr.baseRef) ?? pr.baseShaAtCreation;
  const owner = forge.ownerLogin(repo);
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.databaseId, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: headSha, label: `${owner}:${pr.headRef}`, user: userJson(owner) },
    base: { ref: pr.baseRef, sha: baseSha, label: `${owner}:${pr.baseRef}`, user: userJson(owner) },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: repo.mergeableState(pr) === 'MERGEABLE',
    user: userJson(owner),
    created_at: created,
    updated_at: created,
    closed_at: pr.state === 'closed' ? (pr.mergedAt ?? created) : null,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pr.number}`,
  };
}

function commentJson(forge: Forge, repo: Repo, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  const created = forge.isoFor(comment.createdSeq);
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.databaseId, comment.id),
    body: comment.body,
    user: userJson(forge.ownerLogin(repo)),
    created_at: created,
    updated_at: created,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: T[], query: URLSearchParams, host: string, path: string): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const origin = `http://${host}`;
    link = `<${origin}${path}?page=${page + 1}&per_page=${perPage}>; rel="next"`;
  }
  return { page: slice, link };
}

function withLink(response: RestResponse, link: string | null): RestResponse {
  if (link) response.headers['Link'] = link;
  return response;
}

// ---------------------------------------------------------------------------
// Contents helpers
// ---------------------------------------------------------------------------

type ResolvedPath =
  | { kind: 'file'; oid: string; size: number; mode: string }
  | { kind: 'dir'; oid: string; entries: Array<{ mode: string; name: string; oid: string }> }
  | null;

function resolveContentPath(repo: Repo, commitOid: string, path: string): ResolvedPath {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.body).tree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i++) {
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.body);
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) {
        const dirObj = repo.objects.get(entry.oid);
        if (!dirObj || dirObj.type !== 'tree') return null;
        return { kind: 'dir', oid: entry.oid, entries: parseTree(dirObj.body) };
      }
      treeOid = entry.oid;
    } else {
      if (!last) return null;
      const blob = repo.objects.get(entry.oid);
      return { kind: 'file', oid: entry.oid, size: blob?.body.length ?? 0, mode: entry.mode };
    }
  }
  const rootObj = repo.objects.get(treeOid);
  if (!rootObj || rootObj.type !== 'tree') return null;
  return { kind: 'dir', oid: treeOid, entries: parseTree(rootObj.body) };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(forge: Forge, ctx: RestContext): RestResponse {
  const { method, segments: seg, query } = ctx;
  const path = '/api/v3/' + seg.map((s) => encodeURIComponent(s)).join('/');

  // Root + meta (reachable without auth; the router enforces that split).
  if (seg.length === 0) {
    if (method !== 'GET') return failure(404, 'Not Found');
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return failure(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // Current user.
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return failure(404, 'Not Found');
    const login = forge.viewerLogin();
    if (!login) return failure(404, 'Not Found');
    return json(200, { ...userJson(login), name: login, public_repos: forge.repos.size });
  }

  // User repos.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.databaseId - b.databaseId).map((r) => repoJson(forge, r));
      const { page, link } = paginate(all, query, ctx.host, path);
      return withLink(json(200, page), link);
    }
    if (method === 'POST') {
      const body = parseBody(ctx.body);
      if (!body) return failure(400, 'Invalid JSON body');
      const name = asString(body.name);
      if (!name) return failure(422, 'name is required');
      if (forge.hasRepo(name)) return failure(422, 'name already exists on this account');
      const description = asString(body.description) ?? '';
      const isPrivate = asBoolean(body.private) ?? false;
      const repo = forge.createRepo(name, description, isPrivate);
      return json(201, repoJson(forge, repo));
    }
    return failure(404, 'Not Found');
  }

  // Repo-scoped routes.
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1];
    const repoName = seg[2];
    const repo = forge.repoFor(owner, repoName);
    if (!repo) return failure(404, 'Not Found');
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(forge, repo));
      if (method === 'PATCH') {
        const body = parseBody(ctx.body);
        if (!body) return failure(400, 'Invalid JSON body');
        const description = asString(body.description);
        if (description !== null) repo.description = description;
        const isPrivate = asBoolean(body.private);
        if (isPrivate !== null) repo.isPrivate = isPrivate;
        return json(200, repoJson(forge, repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repoName);
        return { status: 204, headers: {}, body: '' };
      }
      return failure(404, 'Not Found');
    }

    const head = rest[0];

    // Branches.
    if (head === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return failure(404, 'Not Found');
        const names: string[] = [];
        for (const ref of repo.refs.keys()) {
          if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
        }
        names.sort();
        const list = names.map((name) => ({
          name,
          commit: { sha: repo.branchTip(name) },
          protected: false,
        }));
        const { page, link } = paginate(list, query, ctx.host, path);
        return withLink(json(200, page), link);
      }
      const branch = rest.slice(1).join('/');
      if (method !== 'GET') return failure(404, 'Not Found');
      const tip = repo.branchTip(branch);
      if (!tip) return failure(404, 'Branch not found');
      return json(200, { name: branch, commit: { sha: tip }, protected: false });
    }

    // Commits.
    if (head === 'commits') {
      if (method !== 'GET') return failure(404, 'Not Found');
      if (rest.length === 1) {
        const refParam = query.get('sha') ?? repo.defaultBranch;
        const tip = repo.resolveRef(refParam);
        if (!tip) return failure(404, 'Not Found');
        const seen = new Set<string>();
        const ordered: string[] = [];
        const queue = [tip];
        while (queue.length > 0) {
          const oid = queue.shift() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          ordered.push(oid);
          for (const parent of parseCommit(obj.body).parents) queue.push(parent);
        }
        const list = ordered.map((oid) => {
          const info = parseCommit((repo.objects.get(oid) as { body: Buffer }).body);
          return { sha: oid, commit: { message: info.message, author: { name: 'Forge' }, committer: { name: 'Forge' } } };
        });
        const { page, link } = paginate(list, query, ctx.host, path);
        return withLink(json(200, page), link);
      }
      const tip = repo.resolveRef(rest.slice(1).join('/'));
      if (!tip) return failure(404, 'Not Found');
      const info = parseCommit((repo.objects.get(tip) as { body: Buffer }).body);
      return json(200, { sha: tip, commit: { message: info.message } });
    }

    // Git refs.
    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = parseBody(ctx.body);
        if (!body) return failure(400, 'Invalid JSON body');
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (!ref || !ref.startsWith('refs/') || !sha) return failure(422, 'ref and sha are required');
        if (!repo.objects.has(sha)) return failure(422, 'sha does not exist');
        if (repo.refs.has(ref)) return failure(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha }, url: path });
      }
      if (method === 'GET' && rest.length >= 3) {
        const wanted = 'refs/' + rest.slice(2).join('/');
        const exact = repo.refs.get(wanted);
        if (exact) return json(200, { ref: wanted, object: { sha: exact } });
        const matches: Array<{ ref: string; object: { sha: string } }> = [];
        for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (name.startsWith(wanted + '/') || name === wanted) matches.push({ ref: name, object: { sha: oid } });
        }
        if (matches.length === 0) return failure(404, 'Not Found');
        return json(200, matches);
      }
      return failure(404, 'Not Found');
    }

    // Contents.
    if (head === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') {
        const refParam = query.get('ref') ?? repo.defaultBranch;
        const tip = repo.resolveRef(refParam);
        if (!tip) return failure(404, 'Not Found');
        const resolved = resolveContentPath(repo, tip, contentPath);
        if (!resolved) return failure(404, 'Not Found');
        if (resolved.kind === 'file') {
          const blob = repo.objects.get(resolved.oid);
          const content = blob ? blob.body.toString('base64') : '';
          return json(200, {
            type: 'file',
            encoding: 'base64',
            content,
            sha: resolved.oid,
            size: resolved.size,
            name: contentPath.split('/').pop() ?? '',
            path: contentPath,
          });
        }
        const entries = resolved.entries.map((entry) => {
          const childPath = contentPath === '' ? entry.name : `${contentPath}/${entry.name}`;
          if (entry.mode === '40000') return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid };
          const blob = repo.objects.get(entry.oid);
          return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob?.body.length ?? 0 };
        });
        return json(200, entries);
      }
      if (method === 'PUT') {
        const body = parseBody(ctx.body);
        if (!body) return failure(400, 'Invalid JSON body');
        const encoded = asString(body.content);
        if (encoded === null) return failure(422, 'content is required');
        const content = Buffer.from(encoded, 'base64');
        const message = asString(body.message) ?? 'Update file';
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const expectedSha = asString(body.sha);
        let tip = repo.branchTip(branch);
        if (tip === null && branch !== repo.defaultBranch) tip = repo.headTip();
        const files = tip ? new Map(repo.flatten(tip)) : new Map<string, { oid: string; mode: string }>();
        const current = files.get(contentPath);
        if (expectedSha !== null) {
          if (!current || current.oid !== expectedSha) return failure(409, 'sha does not match current file');
        } else if (current) {
          return failure(409, 'file already exists; sha is required to update');
        }
        const blobOid = repo.objects.put('blob', content);
        const created = !current;
        files.set(contentPath, { oid: blobOid, mode: current?.mode ?? '100644' });
        const seq = forge.tick();
        const commitOid = repo.commitOnBranch(branch, files, message, forge.epochFor(seq));
        return json(created ? 201 : 200, {
          content: { sha: blobOid, encoding: 'base64', size: content.length, name: contentPath.split('/').pop() ?? '', path: contentPath },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        const body = parseBody(ctx.body);
        if (!body) return failure(400, 'Invalid JSON body');
        const message = asString(body.message) ?? 'Delete file';
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const expectedSha = asString(body.sha);
        const tip = repo.branchTip(branch) ?? (branch !== repo.defaultBranch ? repo.headTip() : null);
        if (!tip) return failure(404, 'Not Found');
        const files = new Map(repo.flatten(tip));
        const current = files.get(contentPath);
        if (!current) return failure(404, 'Not Found');
        if (expectedSha !== null && current.oid !== expectedSha) return failure(409, 'sha does not match current file');
        files.delete(contentPath);
        const seq = forge.tick();
        const commitOid = repo.commitOnBranch(branch, files, message, forge.epochFor(seq));
        return json(200, { commit: { sha: commitOid, message } });
      }
      return failure(404, 'Not Found');
    }

    // Labels.
    if (head === 'labels') {
      if (method === 'GET') {
        const list = [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' }));
        return json(200, list);
      }
      if (method === 'POST') {
        const body = parseBody(ctx.body);
        if (!body) return failure(400, 'Invalid JSON body');
        const name = asString(body.name);
        if (!name) return failure(422, 'name is required');
        const color = asString(body.color) ?? 'ededed';
        repo.labels.set(name, { name, color });
        return json(201, { name, color, description: '' });
      }
      return failure(404, 'Not Found');
    }

    // Issues.
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, link } = paginate(list.map((i) => issueJson(forge, repo, i)), query, ctx.host, path);
          return withLink(json(200, page), link);
        }
        if (method === 'POST') {
          const body = parseBody(ctx.body);
          if (!body) return failure(400, 'Invalid JSON body');
          const title = asString(body.title);
          if (!title) return failure(422, 'title is required');
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = [];
          for (const raw of rawLabels) {
            const name = typeof raw === 'string' ? raw : (raw as { name?: unknown })?.name;
            if (typeof name !== 'string') continue;
            if (!repo.labels.has(name)) return failure(422, `Label '${name}' does not exist`);
            labels.push(name);
          }
          const issue: IssueRec = {
            id: forge.nextId(),
            number: repo.nextNumber++,
            title,
            body: asString(body.body) ?? '',
            state: 'open',
            labels,
            createdSeq: forge.tick(),
            comments: [],
          };
          repo.issues.set(issue.number, issue);
          return json(201, issueJson(forge, repo, issue));
        }
        return failure(404, 'Not Found');
      }
      const number = parseInt(rest[1], 10);
      const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (!issue) return failure(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, issueJson(forge, repo, issue));
        if (method === 'PATCH') {
          const body = parseBody(ctx.body);
          if (!body) return failure(400, 'Invalid JSON body');
          const state = asString(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(body.title);
          if (title !== null) issue.title = title;
          const text = asString(body.body);
          if (text !== null) issue.body = text;
          return json(200, issueJson(forge, repo, issue));
        }
        return failure(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const list = issue.comments.map((c) => commentJson(forge, repo, c));
          const { page, link } = paginate(list, query, ctx.host, path);
          return withLink(json(200, page), link);
        }
        if (method === 'POST') {
          const body = parseBody(ctx.body);
          if (!body) return failure(400, 'Invalid JSON body');
          const text = asString(body.body);
          if (text === null) return failure(422, 'body is required');
          const comment = { id: repo.nextCommentId++, body: text, createdSeq: forge.tick() };
          issue.comments.push(comment);
          return json(201, commentJson(forge, repo, comment));
        }
        return failure(404, 'Not Found');
      }
      return failure(404, 'Not Found');
    }

    // Pull requests.
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.number - a.number);
          const { page, link } = paginate(list.map((p) => pullJson(forge, repo, p)), query, ctx.host, path);
          return withLink(json(200, page), link);
        }
        if (method === 'POST') {
          const body = parseBody(ctx.body);
          if (!body) return failure(400, 'Invalid JSON body');
          const title = asString(body.title);
          if (!title) return failure(422, 'title is required');
          let headRef = asString(body.head) ?? '';
          const colon = headRef.indexOf(':');
          if (colon !== -1) headRef = headRef.slice(colon + 1);
          const baseRef = asString(body.base) ?? repo.defaultBranch;
          const headTip = repo.branchTip(headRef);
          if (!headTip) return failure(422, 'head branch does not exist');
          const baseTip = repo.branchTip(baseRef);
          if (!baseTip) return failure(422, 'base branch does not exist');
          const pr: PullRec = {
            id: forge.nextId(),
            number: repo.nextNumber++,
            title,
            body: asString(body.body) ?? '',
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
          return json(201, pullJson(forge, repo, pr));
        }
        return failure(404, 'Not Found');
      }
      const number = parseInt(rest[1], 10);
      const pr = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (!pr) return failure(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, pullJson(forge, repo, pr));
        return failure(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return failure(404, 'Not Found');
        const headTip = repo.branchTip(pr.headRef) ?? pr.headShaAtCreation;
        const baseTip = repo.branchTip(pr.baseRef) ?? pr.baseShaAtCreation;
        const base = mergeBase(repo.objects, baseTip, headTip);
        const files = repo.diffCommits(base, headTip);
        return json(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return failure(404, 'Not Found');
        const body = parseBody(ctx.body);
        if (!body) return failure(400, 'Invalid JSON body');
        if (pr.merged || pr.state !== 'open') return failure(405, 'Pull request is already merged or closed');
        const headTip = repo.branchTip(pr.headRef) ?? pr.headShaAtCreation;
        const baseTip = repo.branchTip(pr.baseRef) ?? pr.baseShaAtCreation;
        const base = mergeBase(repo.objects, baseTip, headTip);
        const { merged, conflicts } = repo.threeWayMerge(base, baseTip, headTip);
        if (conflicts.length > 0) return failure(405, 'Merge conflict');
        const seq = forge.tick();
        const sha = repo.commitOnBranch(pr.baseRef, merged, `Squash merge #${pr.number}: ${pr.title}`, forge.epochFor(seq));
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = forge.isoFor(seq);
        pr.mergeCommitSha = sha;
        return json(200, { merged: true, sha, message: 'Pull Request successfully merged' });
      }
      return failure(404, 'Not Found');
    }

    return failure(404, 'Not Found');
  }

  return failure(404, 'Not Found');
}
