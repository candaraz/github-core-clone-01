// Forge data model: repositories, refs, issues, pull requests, labels,
// comments. Owns the object store per repo, lazy owner binding, the learned
// viewer login, deterministic timestamps, and the diff/merge engines.
// Everything is in memory; objects are immutable once stored.

import {
  ObjectStore,
  buildCommit,
  buildTree,
  hashObject,
  identityLine,
  mergeBase,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './objects.ts';

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

const FALLBACK_NOW_MS = Date.parse('2025-01-01T00:00:00Z');

export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (!raw) return FALLBACK_NOW_MS;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? FALLBACK_NOW_MS : parsed;
}

// ---------------------------------------------------------------------------
// Global (GraphQL) ids: opaque, stable, never a bare number.
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const segments = decoded.split(':');
    if (segments.length < 2) return null;
    const kind = segments[0];
    if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
    return { kind, parts: segments.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreation: string;
  baseShaAtCreation: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  comments: CommentRec[];
}

export interface FlatFile {
  oid: string;
  mode: string;
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repo {
  readonly databaseId: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  owner: string | null = null;
  readonly objects = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextNumber = 1;
  nextCommentId = 1;
  readonly createdSeq: number;
  /** Fetch response cache: request signature -> full response bytes. Safe forever: packs depend only on immutable objects + request args. */
  readonly packCache = new Map<string, Buffer>();
  private flattenCache = new Map<string, Map<string, FlatFile>>();
  private diffCache = new Map<string, DiffFile[]>();

  constructor(databaseId: number, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.databaseId = databaseId;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
  }

  get unborn(): boolean {
    return !this.refs.has(`refs/heads/${this.defaultBranch}`);
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  headTip(): string | null {
    return this.branchTip(this.defaultBranch);
  }

  /** Resolve a branch name, full ref, or raw oid to a commit oid. */
  resolveRef(ref: string): string | null {
    if (ref === 'HEAD') return this.headTip();
    const direct = this.refs.get(ref);
    if (direct) return direct;
    const branch = this.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) return ref;
    return null;
  }

  /** Flatten a commit's tree to path -> file. Cached: commits are immutable. */
  flatten(commitOid: string): Map<string, FlatFile> {
    const cached = this.flattenCache.get(commitOid);
    if (cached) return cached;
    const out = new Map<string, FlatFile>();
    const commit = this.objects.get(commitOid);
    if (commit && commit.type === 'commit') {
      const stack: Array<{ tree: string; prefix: string }> = [{ tree: parseCommit(commit.body).tree, prefix: '' }];
      while (stack.length > 0) {
        const { tree, prefix } = stack.pop() as { tree: string; prefix: string };
        const treeObj = this.objects.get(tree);
        if (!treeObj || treeObj.type !== 'tree') continue;
        for (const entry of parseTree(treeObj.body)) {
          const path = prefix + entry.name;
          if (entry.mode === '40000') stack.push({ tree: entry.oid, prefix: path + '/' });
          else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
        }
      }
    }
    this.flattenCache.set(commitOid, out);
    return out;
  }

  /** Build tree objects for a flat file map; returns the root tree oid. */
  buildTreeFromMap(files: Map<string, FlatFile>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: file.mode, name: rest, oid: file.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        const sub = buildLevel(prefix + dir + '/');
        entries.push({ mode: '40000', name: dir, oid: sub });
      }
      return this.objects.put('tree', buildTree(entries));
    };
    return buildLevel('');
  }

  /** Create a commit on a branch (creating the branch from the default tip when needed). */
  commitOnBranch(branch: string, files: Map<string, FlatFile>, message: string, epochSeconds: number): string {
    let parent = this.branchTip(branch);
    if (parent === null && branch !== this.defaultBranch) parent = this.headTip();
    const tree = this.buildTreeFromMap(files);
    const identity = identityLine(epochSeconds);
    const parents = parent ? [parent] : [];
    const oid = this.objects.put('commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
    this.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** Line-diff two blobs; returns [additions, deletions] via LCS. */
  private lineDiff(oldText: string, newText: string): [number, number] {
    const split = (text: string): string[] => {
      if (text === '') return [];
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const a = split(oldText);
    const b = split(newText);
    // LCS lengths with two rolling rows.
    let prev = new Array<number>(b.length + 1).fill(0);
    let curr = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      curr[0] = 0;
      for (let j = 1; j <= b.length; j++) {
        curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    const lcs = prev[b.length];
    return [b.length - lcs, a.length - lcs];
  }

  /** Diff the trees of two commits (merge-base vs head for PR files). Cached. */
  diffCommits(baseOid: string | null, headOid: string): DiffFile[] {
    const key = `${baseOid ?? 'empty'}..${headOid}`;
    const cached = this.diffCache.get(key);
    if (cached) return cached;
    const baseMap = baseOid ? this.flatten(baseOid) : new Map<string, FlatFile>();
    const headMap = this.flatten(headOid);
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    const out: DiffFile[] = [];
    for (const path of [...paths].sort()) {
      const before = baseMap.get(path);
      const after = headMap.get(path);
      if (before && !after) {
        const text = this.objects.get(before.oid)?.body.toString('utf8') ?? '';
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (!before && after) {
        const text = this.objects.get(after.oid)?.body.toString('utf8') ?? '';
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (before && after && before.oid !== after.oid) {
        const oldText = this.objects.get(before.oid)?.body.toString('utf8') ?? '';
        const newText = this.objects.get(after.oid)?.body.toString('utf8') ?? '';
        const [additions, deletions] = this.lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    this.diffCache.set(key, out);
    return out;
  }

  /**
   * Three-way merge at file granularity. Returns the merged flat map plus the
   * list of conflicting paths (both sides changed the same path differently).
   */
  threeWayMerge(baseOid: string | null, oursOid: string, theirsOid: string): { merged: Map<string, FlatFile>; conflicts: string[] } {
    const baseMap = baseOid ? this.flatten(baseOid) : new Map<string, FlatFile>();
    const oursMap = this.flatten(oursOid);
    const theirsMap = this.flatten(theirsOid);
    const paths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
    const merged = new Map<string, FlatFile>();
    const conflicts: string[] = [];
    for (const path of paths) {
      const b = baseMap.get(path)?.oid;
      const o = oursMap.get(path);
      const t = theirsMap.get(path);
      if (o?.oid === t?.oid) {
        if (o) merged.set(path, o);
      } else if (o?.oid === b) {
        if (t) merged.set(path, t);
      } else if (t?.oid === b) {
        if (o) merged.set(path, o);
      } else {
        conflicts.push(path);
        if (o) merged.set(path, o);
      }
    }
    return { merged, conflicts };
  }

  /** Mergeability of a PR: UNKNOWN when a side is missing, else live conflict check. */
  mergeableState(pr: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const head = this.branchTip(pr.headRef);
    const base = this.branchTip(pr.baseRef);
    if (!head || !base) return 'UNKNOWN';
    const baseCommit = mergeBase(this.objects, base, head);
    const { conflicts } = this.threeWayMerge(baseCommit, base, head);
    return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }
}

// ---------------------------------------------------------------------------
// Forge: all repos, owner binding, learned viewer, id counters, clock.
// ---------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextDatabaseId = 1;
  private nextRecordId = 1;
  private sequence = 0;
  readonly baseNowMs: number;
  learnedLogin: string | null = null;

  constructor() {
    this.baseNowMs = trialNowMs();
  }

  /** Monotonic tick: distinct, increasing, deterministic timestamps. */
  tick(): number {
    return this.sequence++;
  }

  isoFor(seq: number): string {
    return new Date(this.baseNowMs + seq * 1000).toISOString();
  }

  epochFor(seq: number): number {
    return Math.floor(this.baseNowMs / 1000) + seq;
  }

  nextId(): number {
    return this.nextRecordId++;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextDatabaseId++, name, description, isPrivate, this.tick());
    this.repos.set(name, repo);
    return repo;
  }

  hasRepo(name: string): boolean {
    return this.repos.has(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /**
   * Resolve a repo by owner + name with lazy owner binding. The first
   * owner-bearing request for an existing repo binds it to that owner and
   * teaches the forge the viewer login; later requests under a different
   * owner are foreign (null). Requests for missing repos never bind.
   */
  repoFor(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (repo.owner === null) {
      repo.owner = owner;
      if (this.learnedLogin === null) this.learnedLogin = owner;
    }
    if (repo.owner !== owner) return null;
    return repo;
  }

  /** Viewer login for viewer/user surfaces; null until any owner is learned. */
  viewerLogin(): string | null {
    return this.learnedLogin;
  }

  /** Owner display for a repo: bound owner, else the learned login, else ''. */
  ownerLogin(repo: Repo): string {
    return repo.owner ?? this.learnedLogin ?? '';
  }
}

/** Recompute an object's oid from its stored type + body (integrity helper). */
export function storedOid(type: 'commit' | 'tree' | 'blob' | 'tag', body: Buffer): string {
  return hashObject(type, body);
}
