// GitHub REST API v3: repositories, git refs, contents, issues, pull requests, labels.
//
// Responses are supersets of what the suite asserts (the suite's shape checker allows extra
// fields), so serializers include the familiar GitHub fields. The perf-critical read path —
// GET /repos/{owner}/{repo}/issues/{number} — serves cached whole-response bytes keyed by
// repository version, so repeated reads of an unchanged issue cost no serialization at all.

import { buildCommit } from './gitobj.ts';
import { IDENTITY } from './store.ts';
import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';

// --------------------------------------------------------------------------- serializers

function userJson() {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User' };
}

export function repoJson(store, repo) {
  let openCount = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openCount += 1;
  for (const pr of repo.pulls.values()) if (pr.state === 'open') openCount += 1;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: DEFAULT_BRANCH,
    created_at: isoSec(repo.createdSec),
    updated_at: isoSec(repo.updatedSec),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: openCount,
  };
}

function isoSec(sec) {
  return new Date(sec * 1000).toISOString();
}

function labelJson(label) {
  return { name: label.name, color: label.color };
}

export function issueRecordJson(store, repo, issue, asPullRequest) {
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return label === undefined ? { name, color: '000000' } : labelJson(label);
  });
  const json = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(),
    created_at: isoSec(issue.createdSec),
    updated_at: isoSec(issue.updatedSec),
    closed_at: issue.closedSec === null ? null : isoSec(issue.closedSec),
    comments: issue.comments.length,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
  };
  if (asPullRequest) json.pull_request = {};
  return json;
}

export function prRecordJson(store, repo, pr) {
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? null;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === 'open' ? 'open' : 'closed',
    head: { ref: pr.headRef, sha: headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: userJson(),
    created_at: isoSec(pr.createdSec),
    updated_at: isoSec(pr.updatedSec),
    closed_at: pr.closedSec === null ? null : isoSec(pr.closedSec),
    merged: pr.merged,
    merged_at: pr.mergedAtSec === null ? null : isoSec(pr.mergedAtSec),
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open' ? !repo.mergeWouldConflict(pr) : false,
    comments: pr.comments.length,
    draft: false,
    locked: false,
  };
}

function commentJson(comment) {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: isoSec(comment.createdSec),
    updated_at: isoSec(comment.updatedSec),
  };
}

function parseIdent(line) {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: isoSec(1735689600) };
  return { name: match[1], email: match[2], date: isoSec(Number(match[3])) };
}

// --------------------------------------------------------------------------- helpers

function notFound(message) {
  return { status: 404, json: { message: message ?? 'Not Found' } };
}

function unprocessable(message) {
  return { status: 422, json: { message } };
}

function getRepo(store, owner, name) {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function pageParams(query) {
  let perPage = parseInt(query.per_page ?? '30', 10);
  if (Number.isNaN(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = parseInt(query.page ?? '1', 10);
  if (Number.isNaN(page) || page < 1) page = 1;
  return { perPage, page };
}

function paginate(items, query, ctx, path) {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const base = `http://${ctx.host}${path}`;
    headers.Link = `<${base}?per_page=${perPage}&page=${page + 1}>; rel="next", <${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`;
  }
  return { status: 200, json: slice, headers };
}

function makeCommit(store, repo, tree, parents, message) {
  return repo.putObject(
    'commit',
    buildCommit({ tree, parents, author: IDENTITY, committer: IDENTITY, timestamp: store.tick(), message }),
  );
}

function branchTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`);
}

// --------------------------------------------------------------------------- router

export function handleRest(ctx) {
  const { store } = ctx;
  const seg = ctx.segments; // decoded segments after /api/v3

  // GET /api/v3 and /api/v3/
  if (seg.length === 0) {
    if (ctx.method !== 'GET') return notFound();
    return { status: 200, json: {}, headers: { 'X-OAuth-Scopes': 'repo, read:org' } };
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (ctx.method !== 'GET') return notFound();
    return { status: 200, json: { installed_version: '1.0.0' } };
  }

  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (ctx.method !== 'GET') return notFound();
      return { status: 200, json: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' } };
    }
    if (seg[1] === 'repos' && seg.length === 2) {
      if (ctx.method === 'POST') return createRepo(ctx);
      if (ctx.method === 'GET') {
        const repos = store.listRepos().map((repo) => repoJson(store, repo));
        return paginate(repos, ctx.query, ctx, '/api/v3/user/repos');
      }
      return notFound();
    }
    return notFound();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1];
  const name = seg[2];
  const repo = getRepo(store, owner, name);
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (repo === null) return notFound('repository not found');
    if (ctx.method === 'GET') {
      if (repo.repoBytes !== null && repo.repoBytes.version === repo.version) {
        return { status: 200, buffer: repo.repoBytes.buffer, contentType: 'application/json' };
      }
      const buffer = Buffer.from(JSON.stringify(repoJson(store, repo)), 'utf8');
      repo.repoBytes = { version: repo.version, buffer };
      return { status: 200, buffer, contentType: 'application/json' };
    }
    if (ctx.method === 'PATCH') {
      const body = ctx.json ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedSec = store.tick();
      repo.bump();
      return { status: 200, json: repoJson(store, repo) };
    }
    if (ctx.method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, json: null };
    }
    return notFound();
  }
  if (repo === null) return notFound('repository not found');

  const head = rest[0];
  if (head === 'git' && rest[1] === 'refs') return handleGitRefs(ctx, repo, rest.slice(2));
  if (head === 'branches') return handleBranches(ctx, repo, rest.slice(1));
  if (head === 'commits' && rest.length === 1) return handleCommits(ctx, repo);
  if (head === 'contents') return handleContents(ctx, repo, rest.slice(1));
  if (head === 'labels') return handleLabels(ctx, repo, rest.slice(1));
  if (head === 'issues') return handleIssues(ctx, repo, rest.slice(1));
  if (head === 'pulls') return handlePulls(ctx, repo, rest.slice(1));
  return notFound();
}

// --------------------------------------------------------------------------- repos

function createRepo(ctx) {
  const { store } = ctx;
  const body = ctx.json ?? {};
  const name = body.name;
  if (typeof name !== 'string' || name === '') return unprocessable('name is required');
  if (store.getRepo(VIEWER.login, name) !== undefined) {
    return unprocessable(`name already exists on this account`);
  }
  const repo = store.createRepo(name, {
    description: typeof body.description === 'string' ? body.description : '',
    isPrivate: body.private === true,
  });
  return { status: 201, json: repoJson(store, repo) };
}

// --------------------------------------------------------------------------- git refs

function handleGitRefs(ctx, repo, rest) {
  const { store } = ctx;
  if (rest.length === 0) {
    if (ctx.method !== 'POST') return notFound();
    const body = ctx.json ?? {};
    const ref = body.ref;
    const sha = body.sha;
    if (typeof ref !== 'string' || ref === '' || typeof sha !== 'string' || sha === '') {
      return unprocessable('ref and sha are required');
    }
    repo.refs.set(ref, sha);
    repo.bump();
    const object = repo.getObject(sha);
    return { status: 201, json: { ref, object: { sha, type: object?.type ?? 'commit' } } };
  }
  if (ctx.method !== 'GET') return notFound();
  const fullRef = `refs/${rest.join('/')}`;
  const sha = repo.refs.get(fullRef);
  if (sha === undefined) return notFound('ref not found');
  const object = repo.getObject(sha);
  return { status: 200, json: { ref: fullRef, object: { sha, type: object?.type ?? 'commit' } } };
}

// --------------------------------------------------------------------------- branches

function handleBranches(ctx, repo, rest) {
  if (ctx.method !== 'GET') return notFound();
  if (rest.length === 0) {
    const branches = [];
    for (const [name, oid] of repo.sortedRefs()) {
      if (name.startsWith('refs/heads/')) {
        branches.push({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
    }
    return { status: 200, json: branches };
  }
  const branch = rest.join('/');
  const sha = branchTip(repo, branch);
  if (sha === undefined) return notFound('branch not found');
  return { status: 200, json: { name: branch, commit: { sha }, protected: false } };
}

// --------------------------------------------------------------------------- commits

function handleCommits(ctx, repo) {
  if (ctx.method !== 'GET') return notFound();
  const rev = ctx.query.sha;
  let tip;
  if (rev === undefined || rev === '') {
    tip = repo.headTip();
    if (tip === undefined) return { status: 200, json: [] };
    tip = repo.peelToCommit(tip);
    if (tip === null) return { status: 200, json: [] };
  } else {
    const resolved = repo.resolveRevision(rev);
    if (resolved === null || resolved === undefined) return notFound('ref not found');
    tip = resolved;
  }
  const items = [];
  for (const oid of repo.listCommits(tip)) {
    const commit = repo.commitOf(oid);
    if (commit === null) continue;
    const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
    items.push({
      sha: oid,
      commit: {
        message,
        author: parseIdent(commit.author),
        committer: parseIdent(commit.committer),
      },
      parents: commit.parents.map((sha) => ({ sha })),
    });
  }
  return { status: 200, json: items };
}

// --------------------------------------------------------------------------- contents

function handleContents(ctx, repo, rest) {
  const { store } = ctx;
  const path = rest.join('/');
  if (ctx.method === 'GET') {
    const rev = ctx.query.ref;
    let tip;
    if (rev === undefined || rev === '') {
      tip = repo.headTip();
      if (tip === undefined) return notFound('repository is empty');
      tip = repo.peelToCommit(tip);
    } else {
      const resolved = repo.resolveRevision(rev);
      if (resolved === null || resolved === undefined) return notFound('ref not found');
      tip = resolved;
    }
    if (tip === null) return notFound('ref not found');
    const commit = repo.commitOf(tip);
    if (commit === null) return notFound('ref not found');
    if (path === '') {
      const listing = repo.listDir(commit.tree, '');
      return { status: 200, json: dirJson(repo, commit.tree, '', listing ?? []) };
    }
    const entry = repo.lookupPath(commit.tree, path);
    if (entry === null) return notFound('path not found');
    if (entry.isDir) {
      const listing = repo.listDir(commit.tree, path);
      return { status: 200, json: dirJson(repo, commit.tree, path, listing ?? []) };
    }
    const object = repo.getObject(entry.oid);
    if (object === undefined) return notFound('path not found');
    return {
      status: 200,
      json: {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: entry.oid,
        size: object.data.length,
        name: path.split('/').pop(),
        path,
      },
    };
  }

  if (ctx.method === 'PUT') {
    const body = ctx.json ?? {};
    if (path === '') return unprocessable('path is required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
    const message = typeof body.message === 'string' ? body.message : '';
    const content = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
    let tip = branchTip(repo, branch);
    if (tip === undefined) {
      // Unknown branches are created from the default tip.
      tip = repo.headTip();
      if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    const tipCommit = tip === undefined ? null : repo.commitOf(repo.peel(tip));
    const baseTree = tipCommit === null ? null : tipCommit.tree;
    const existing = baseTree === null ? null : repo.lookupPath(baseTree, path);
    const sha = body.sha;
    if (typeof sha === 'string' && sha !== '') {
      if (existing === null || existing.isDir) return unprocessable('sha does not match any file');
      if (existing.oid !== sha) return { status: 409, json: { message: 'sha mismatch' } };
    }
    const blobOid = repo.putObject('blob', content);
    const tree = repo.setPath(baseTree, path, blobOid);
    const parents = tip === undefined ? [] : [repo.peel(tip)];
    const commitOid = makeCommit(store, repo, tree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.bump();
    return {
      status: existing === null ? 201 : 200,
      json: {
        content: { sha: blobOid, encoding: 'base64', size: content.length, name: path.split('/').pop(), path },
        commit: { sha: commitOid },
      },
    };
  }

  if (ctx.method === 'DELETE') {
    const body = ctx.json ?? {};
    if (path === '') return unprocessable('path is required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
    const tip = branchTip(repo, branch);
    if (tip === undefined) return notFound('branch not found');
    const tipCommit = repo.commitOf(repo.peel(tip));
    if (tipCommit === null) return notFound('branch not found');
    const existing = repo.lookupPath(tipCommit.tree, path);
    if (existing === null || existing.isDir) return notFound('path not found');
    const sha = body.sha;
    if (typeof sha === 'string' && sha !== '' && existing.oid !== sha) {
      return { status: 409, json: { message: 'sha mismatch' } };
    }
    const tree = repo.setPath(tipCommit.tree, path, null);
    const message = typeof body.message === 'string' ? body.message : '';
    const commitOid = makeCommit(store, repo, tree, [repo.peel(tip)], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.bump();
    return { status: 200, json: { commit: { sha: commitOid } } };
  }

  return notFound();
}

function dirJson(repo, treeOid, path, listing) {
  return listing.map((entry) => {
    const object = entry.isDir ? undefined : repo.getObject(entry.oid);
    return {
      type: entry.isDir ? 'dir' : 'file',
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
      size: object === undefined ? 0 : object.data.length,
    };
  });
}

// --------------------------------------------------------------------------- labels

function handleLabels(ctx, repo, rest) {
  if (rest.length !== 0) return notFound();
  if (ctx.method === 'GET') {
    const labels = [...repo.labels.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(labelJson);
    return { status: 200, json: labels };
  }
  if (ctx.method === 'POST') {
    const body = ctx.json ?? {};
    const name = body.name;
    if (typeof name !== 'string' || name === '') return unprocessable('name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    const label = { name, color };
    repo.labels.set(name, label);
    repo.bump();
    return { status: 201, json: labelJson(label) };
  }
  return notFound();
}

// --------------------------------------------------------------------------- issues

function findSubject(repo, number) {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return { kind: 'issue', record: issue };
  const pr = repo.pulls.get(number);
  if (pr !== undefined) return { kind: 'pr', record: pr };
  return null;
}

function handleIssues(ctx, repo, rest) {
  const { store } = ctx;
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const body = ctx.json ?? {};
      const labels = Array.isArray(body.labels) ? body.labels : [];
      for (const label of labels) {
        const name = typeof label === 'string' ? label : label?.name;
        if (typeof name !== 'string' || !repo.labels.has(name)) {
          return unprocessable(`label not found: ${String(name)}`);
        }
      }
      const now = store.tick();
      const issue = {
        id: store.nextGlobalId++,
        number: repo.nextNumber++,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labels.map((label) => (typeof label === 'string' ? label : label.name)),
        createdSec: now,
        updatedSec: now,
        closedSec: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      repo.bump();
      return { status: 201, json: issueRecordJson(store, repo, issue, false) };
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.state ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const direction = ctx.query.direction === 'asc' ? 1 : -1;
      issues.sort((a, b) => {
        if (a.createdSec !== b.createdSec) return (a.createdSec - b.createdSec) * direction;
        return (a.number - b.number) * direction;
      });
      const json = issues.map((issue) => issueRecordJson(store, repo, issue, false));
      return paginate(json, ctx.query, ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('issue not found');

  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      const key = `${repo.version}|${number}`;
      const cached = repo.issueBytes.get(key);
      if (cached !== undefined) return { status: 200, buffer: cached, contentType: 'application/json' };
      const subject = findSubject(repo, number);
      if (subject === null) return notFound('issue not found');
      const json = subject.kind === 'issue'
        ? issueRecordJson(store, repo, subject.record, false)
        : issueRecordJson(store, repo, subject.record, true);
      const buffer = Buffer.from(JSON.stringify(json), 'utf8');
      if (repo.issueBytes.size > 512) repo.issueBytes.clear();
      repo.issueBytes.set(key, buffer);
      return { status: 200, buffer, contentType: 'application/json' };
    }
    if (ctx.method === 'PATCH') {
      const subject = findSubject(repo, number);
      if (subject === null) return notFound('issue not found');
      const body = ctx.json ?? {};
      const record = subject.record;
      if (Array.isArray(body.labels)) {
        for (const label of body.labels) {
          const name = typeof label === 'string' ? label : label?.name;
          if (typeof name !== 'string' || !repo.labels.has(name)) {
            return unprocessable(`label not found: ${String(name)}`);
          }
        }
        record.labels = body.labels.map((label) => (typeof label === 'string' ? label : label.name));
      }
      if (typeof body.title === 'string') record.title = body.title;
      if (typeof body.body === 'string') record.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        record.state = body.state;
        record.closedSec = body.state === 'closed' ? store.tick() : null;
      }
      record.updatedSec = store.tick();
      repo.bump();
      if (subject.kind === 'issue') return { status: 200, json: issueRecordJson(store, repo, record, false) };
      return { status: 200, json: prRecordJson(store, repo, record) };
    }
    return notFound();
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    const subject = findSubject(repo, number);
    if (subject === null) return notFound('issue not found');
    if (ctx.method === 'GET') {
      return { status: 200, json: subject.record.comments.map(commentJson) };
    }
    if (ctx.method === 'POST') {
      const body = ctx.json ?? {};
      const now = store.tick();
      const comment = {
        id: store.nextGlobalId++,
        body: typeof body.body === 'string' ? body.body : '',
        createdSec: now,
        updatedSec: now,
      };
      subject.record.comments.push(comment);
      repo.bump();
      return { status: 201, json: commentJson(comment) };
    }
    return notFound();
  }
  return notFound();
}

// --------------------------------------------------------------------------- pull requests

function handlePulls(ctx, repo, rest) {
  const { store } = ctx;
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const body = ctx.json ?? {};
      const head = body.head;
      const base = body.base;
      if (typeof head !== 'string' || typeof base !== 'string') {
        return unprocessable('head and base are required');
      }
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        return unprocessable('head or base branch not found');
      }
      const now = store.tick();
      const pr = {
        id: store.nextGlobalId++,
        number: repo.nextNumber++,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
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
      return { status: 201, json: prRecordJson(store, repo, pr) };
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.state ?? 'open';
      let prs = [...repo.pulls.values()];
      if (state === 'open') prs = prs.filter((pr) => pr.state === 'open');
      else if (state === 'closed') prs = prs.filter((pr) => pr.state !== 'open');
      prs.sort((a, b) => b.createdSec - a.createdSec || b.number - a.number);
      const json = prs.map((pr) => prRecordJson(store, repo, pr));
      return paginate(json, ctx.query, ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('pull request not found');
  const pr = repo.pulls.get(number);
  if (pr === undefined) return notFound('pull request not found');

  if (rest.length === 1) {
    if (ctx.method !== 'GET') return notFound();
    return { status: 200, json: prRecordJson(store, repo, pr) };
  }
  if (rest[1] === 'files' && rest.length === 2) {
    if (ctx.method !== 'GET') return notFound();
    return { status: 200, json: repo.prFiles(pr) };
  }
  if (rest[1] === 'merge' && rest.length === 2) {
    if (ctx.method !== 'PUT') return notFound();
    if (pr.merged) return { status: 405, json: { message: 'pull request already merged' } };
    const result = repo.squashMerge(pr, store, pr.title);
    if (result.conflict === true) {
      return { status: 405, json: { message: 'merge conflict' } };
    }
    repo.refs.set(`refs/heads/${pr.baseRef}`, result.oid);
    const now = store.tick();
    pr.merged = true;
    pr.state = 'closed';
    pr.closedSec = now;
    pr.mergedAtSec = now;
    pr.mergeCommitSha = result.oid;
    pr.updatedSec = now;
    repo.bump();
    return { status: 200, json: { sha: result.oid, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}
