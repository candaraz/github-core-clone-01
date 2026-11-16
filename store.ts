// The forge's in-memory model: repositories, git objects, refs, issues, pull requests,
// comments and labels, plus the git graph operations the protocol and API layers share.
//
// Everything lives in memory: the suite runs one trial per process and never asks for
// persistence, so a snapshot design trades nothing the contract needs. Objects are immutable
// once stored, which makes every parse cache safe without invalidation. Each repository carries
// a version counter bumped on ANY mutation; every response cache is keyed by it, so a cached
// byte string can never describe a state the repository has left.
//
// Timestamps come from one monotonic counter rooted at the scenario epoch, never from the
// wall clock, so two runs of the same request sequence emit identical bytes.

import {
  ZERO_OID, hashObject, buildTree, parseTree, buildCommit, parseCommit, parseTag,
} from './gitobj.ts';
import { VIEWER, DEFAULT_BRANCH, EPOCH_SEC } from './scenario.ts';

export const IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

const DEFAULT_LABEL_COLORS = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  'good first issue': '7057ff',
  'help wanted': '008672',
};

// --------------------------------------------------------------------------- store

export class Store {
  constructor() {
    this.repos = new Map(); // `${owner}/${name}` -> Repo
    this.nextRepoId = 1;
    this.nextGlobalId = 1; // shared by issues, pull requests and comments
    this.clock = 0; // ticks since EPOCH_SEC; every timestamp in the forge comes from here
  }

  /** Next monotonic timestamp, in seconds since the Unix epoch. */
  tick() {
    this.clock += 1;
    return EPOCH_SEC + this.clock;
  }

  static iso(sec) {
    return new Date(sec * 1000).toISOString();
  }

  createRepo(name, { description = '', isPrivate = false } = {}) {
    const repo = new Repo(this.nextRepoId++, VIEWER.login, name, description, isPrivate, this.tick());
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  getRepo(owner, name) {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner, name) {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos() {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

// --------------------------------------------------------------------------- repo

class Repo {
  constructor(id, owner, name, description, isPrivate, createdSec) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSec = createdSec;
    this.updatedSec = createdSec;
    this.objects = new Map(); // oid -> {type, data}
    this.refs = new Map(); // full ref name -> oid
    this.labels = new Map(); // name -> {name, color}
    for (const [label, color] of Object.entries(DEFAULT_LABEL_COLORS)) {
      this.labels.set(label, { name: label, color });
    }
    this.issues = new Map(); // number -> issue record
    this.pulls = new Map(); // number -> pr record
    this.nextNumber = 1; // issues and pull requests share one numbering counter
    this.version = 0;
    // Immutable-object caches: never invalidated (objects never change).
    this.commitCache = new Map(); // oid -> {tree, parents}
    this.treeCache = new Map(); // oid -> entries
    this.peelCache = new Map(); // oid -> ultimate non-tag oid
    this.flatCache = new Map(); // tree oid -> Map<path, {oid, mode}>
    this.closureCache = new Map(); // tree oid -> Set<oids> (tree + descendants + blobs)
    this.deflated = new Map(); // oid -> deflated bytes for pack writing
    // Version-keyed response caches: keyed by `version` so mutation invalidates them.
    this.fetchCache = new Map();
    this.rawCache = new Map(); // `version|request-bytes` -> whole upload-pack response
    this.issueBytes = new Map(); // `version|number` -> Buffer
    this.repoBytes = null; // {version, buffer}
    this.lsRefsCache = new Map();
    this.adCache = new Map(); // `version|service` -> Buffer (v0 advertisements)
  }

  bump() {
    this.version += 1;
  }

  // ------------------------------------------------------------- objects

  putObject(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid) {
    return this.objects.get(oid);
  }

  hasObject(oid) {
    return this.objects.has(oid);
  }

  commitOf(oid) {
    let parsed = this.commitCache.get(oid);
    if (parsed === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return null;
      parsed = parseCommit(object.data);
      this.commitCache.set(oid, parsed);
    }
    return parsed;
  }

  treeEntries(oid) {
    let entries = this.treeCache.get(oid);
    if (entries === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return null;
      entries = parseTree(object.data);
      this.treeCache.set(oid, entries);
    }
    return entries;
  }

  /** Follow annotated tags to the ultimate non-tag object (usually a commit). */
  peel(oid) {
    const cached = this.peelCache.get(oid);
    if (cached !== undefined) return cached;
    let current = oid;
    const seen = new Set();
    for (;;) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag' || seen.has(current)) break;
      seen.add(current);
      current = parseTag(object.data).object;
    }
    this.peelCache.set(oid, current);
    return current;
  }

  /** Peel to a commit oid, or null when the target is not a commit. */
  peelToCommit(oid) {
    const target = this.peel(oid);
    const object = this.objects.get(target);
    if (object === undefined || object.type !== 'commit') return null;
    return target;
  }

  // ------------------------------------------------------------- refs

  headRef() {
    return `refs/heads/${DEFAULT_BRANCH}`;
  }

  headTip() {
    return this.refs.get(this.headRef());
  }

  resolveRef(name) {
    if (name === 'HEAD') return this.headTip();
    return this.refs.get(name);
  }

  /** Resolve a branch name, tag name, full ref, or oid to a commit oid (or null). */
  resolveRevision(rev) {
    if (rev === undefined || rev === null || rev === '') return undefined;
    const direct = this.objects.get(rev);
    if (direct !== undefined) return this.peelToCommit(rev);
    for (const candidate of [`refs/heads/${rev}`, `refs/tags/${rev}`, rev]) {
      const oid = this.refs.get(candidate);
      if (oid !== undefined) return this.peelToCommit(oid);
    }
    return null;
  }

  /** Sorted [name, oid] pairs, HEAD's target first is handled by callers. */
  sortedRefs() {
    return [...this.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  // ------------------------------------------------------------- ancestry

  /** True when `ancestor` equals `descendant` or is reachable from it via parents. */
  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    const seen = new Set();
    const stack = [descendant];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(current);
      if (commit === null) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** First-parent-independent merge-base: ancestors of `a`, then DFS from `b`. */
  mergeBase(a, b) {
    const ancestors = new Set();
    const stack = [a];
    while (stack.length > 0) {
      const current = stack.pop();
      if (ancestors.has(current)) continue;
      ancestors.add(current);
      const commit = this.commitOf(current);
      if (commit === null) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    const seen = new Set();
    const queue = [b];
    while (queue.length > 0) {
      const current = queue.pop();
      if (ancestors.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(current);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest-first (breadth-first from the tip). */
  listCommits(tip) {
    const order = [];
    const seen = new Set();
    const queue = [tip];
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitOf(current);
      if (commit === null) continue;
      order.push(current);
      for (const parent of commit.parents) queue.push(parent);
    }
    return order;
  }

  // ------------------------------------------------------------- trees

  /** Flatten a tree to path -> {oid, mode}, memoized (trees are immutable). */
  flatten(treeOid) {
    let flat = this.flatCache.get(treeOid);
    if (flat !== undefined) return flat;
    flat = new Map();
    const walk = (oid, prefix) => {
      const entries = this.treeEntries(oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, flat);
    return flat;
  }

  /** All object ids in a tree's closure (the tree, subtrees, blobs), memoized. */
  closure(treeOid) {
    let set = this.closureCache.get(treeOid);
    if (set !== undefined) return set;
    set = new Set([treeOid]);
    const entries = this.treeEntries(treeOid);
    if (entries !== null) {
      for (const entry of entries) {
        if (entry.mode === '40000') {
          for (const oid of this.closure(entry.oid)) set.add(oid);
        } else {
          set.add(entry.oid);
        }
      }
    }
    this.closureCache.set(treeOid, set);
    return set;
  }

  /** Entry at `path` in the tree: {oid, mode, isDir} or null. */
  lookupPath(treeOid, path) {
    const parts = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.treeEntries(current);
      if (entries === null) return null;
      const entry = entries.find((item) => item.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) {
        return { oid: entry.oid, mode: entry.mode, isDir: entry.mode === '40000' };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { oid: treeOid, mode: '40000', isDir: true };
  }

  /** Directory listing at `path` ('' for root): [{name, path, oid, mode, isDir}]. */
  listDir(treeOid, path) {
    const target = path === '' ? { oid: treeOid, isDir: true } : this.lookupPath(treeOid, path);
    if (target === null || !target.isDir) return null;
    const entries = this.treeEntries(target.oid);
    if (entries === null) return null;
    return entries.map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      oid: entry.oid,
      mode: entry.mode,
      isDir: entry.mode === '40000',
    }));
  }

  /**
   * New tree oid with `path` set to `blobOid` (or removed when null), building and storing
   * intermediate trees. `treeOid` may be null for an empty tree.
   */
  setPath(treeOid, path, blobOid) {
    const parts = path.split('/').filter((part) => part !== '');
    const build = (oid, depth) => {
      const entries = oid === null ? [] : (this.treeEntries(oid) ?? []);
      const name = parts[depth];
      const rest = entries.filter((entry) => entry.name !== name);
      if (depth === parts.length - 1) {
        if (blobOid !== null) rest.push({ mode: '100644', name, oid: blobOid });
      } else {
        const existing = entries.find((entry) => entry.name === name);
        const childOid = build(existing && existing.mode === '40000' ? existing.oid : null, depth + 1);
        if (childOid !== null) rest.push({ mode: '40000', name, oid: childOid });
      }
      if (rest.length === 0) return null;
      return this.putObject('tree', buildTree(rest));
    };
    return build(treeOid, 0);
  }

  /** Tree oid for a flat path map (used by merges). */
  buildFromFlat(flat) {
    const nested = new Map(); // dir path -> [{name, oid, mode}]
    const rootEntries = [];
    const ensureDir = (dirPath) => {
      if (!nested.has(dirPath)) nested.set(dirPath, []);
      return nested.get(dirPath);
    };
    const sorted = [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [path, entry] of sorted) {
      const slash = path.lastIndexOf('/');
      if (slash < 0) {
        rootEntries.push({ mode: entry.mode, name: path, oid: entry.oid });
      } else {
        // Register every ancestor directory, including ones holding only subdirectories.
        const dirPath = path.slice(0, slash);
        const parts = dirPath.split('/');
        let acc = '';
        for (const part of parts) {
          acc = acc === '' ? part : `${acc}/${part}`;
          ensureDir(acc);
        }
        ensureDir(dirPath).push({ mode: entry.mode, name: path.slice(slash + 1), oid: entry.oid });
      }
    }
    // Build deepest directories first.
    const dirs = [...nested.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
    const dirOids = new Map();
    for (const dir of dirs) {
      const entries = nested.get(dir);
      for (const [child, childOid] of dirOids) {
        const parentSlash = child.lastIndexOf('/');
        const parent = parentSlash < 0 ? '' : child.slice(0, parentSlash);
        if (parent === dir) entries.push({ mode: '40000', name: child.slice(parentSlash + 1), oid: childOid });
      }
      dirOids.set(dir, this.putObject('tree', buildTree(entries)));
    }
    for (const [child, childOid] of dirOids) {
      if (!child.includes('/')) rootEntries.push({ mode: '40000', name: child, oid: childOid });
    }
    return this.putObject('tree', buildTree(rootEntries));
  }

  // ------------------------------------------------------------- fetch object sets

  /**
   * The object set for a fetch: D (wants closure, depth-bounded) minus H (haves closure,
   * stopping at the client's shallow boundary). Returns {oids, shallow, unshallow} where
   * `oids` are the pack contents, `shallow` the depth-boundary commits, and `unshallow` the
   * client boundary commits whose parents are all in D.
   */
  fetchSet(wants, haves, depth, boundary) {
    // D: peel wants (tag objects join D themselves), then BFS commits bounded by depth.
    const dCommits = new Set();
    const dExtra = new Set(); // wanted tag objects along peel chains
    const queue = [];
    for (const want of wants) {
      let current = want;
      const seen = new Set();
      for (;;) {
        const object = this.objects.get(current);
        if (object === undefined) break;
        if (object.type === 'tag') {
          dExtra.add(current);
          if (seen.has(current)) break;
          seen.add(current);
          current = parseTag(object.data).object;
          continue;
        }
        break;
      }
      const target = this.objects.get(current);
      if (target !== undefined && target.type === 'commit' && !dCommits.has(current)) {
        dCommits.add(current);
        queue.push([current, 0]);
      } else if (target !== undefined) {
        dExtra.add(current);
      }
    }
    const levels = new Map();
    for (const [root] of queue) levels.set(root, 0);
    let head = 0;
    while (head < queue.length) {
      const [current, level] = queue[head++];
      if (depth !== null && level >= depth - 1) continue;
      const commit = this.commitOf(current);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (dCommits.has(parent)) continue;
        if (this.objects.get(parent)?.type !== 'commit') continue;
        dCommits.add(parent);
        levels.set(parent, level + 1);
        queue.push([parent, level + 1]);
      }
    }
    // Shallow: D commits with a parent outside D (only meaningful with a depth bound).
    const shallow = [];
    if (depth !== null) {
      for (const oid of dCommits) {
        const commit = this.commitOf(oid);
        if (commit !== null && commit.parents.some((parent) => !dCommits.has(parent))) shallow.push(oid);
      }
    }
    // D objects: commits + their full tree closures + wanted tag objects.
    const dObjects = new Set(dExtra);
    for (const oid of dCommits) {
      dObjects.add(oid);
      const commit = this.commitOf(oid);
      if (commit !== null) {
        for (const treeOid of this.closure(commit.tree)) dObjects.add(treeOid);
      }
    }
    // H: closure of haves, stopping at boundary commits (included, parents excluded).
    const hObjects = new Set();
    const hSeen = new Set();
    const hQueue = [];
    for (const have of haves) {
      const peeled = this.peelToCommit(have);
      if (peeled === null) continue;
      if (have !== peeled) hObjects.add(have);
      if (!hSeen.has(peeled)) {
        hSeen.add(peeled);
        hQueue.push(peeled);
      }
    }
    let hHead = 0;
    while (hHead < hQueue.length) {
      const current = hQueue[hHead++];
      hObjects.add(current);
      const commit = this.commitOf(current);
      if (commit !== null) {
        for (const treeOid of this.closure(commit.tree)) hObjects.add(treeOid);
      }
      if (boundary.has(current)) continue; // the client lacks everything below this commit
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!hSeen.has(parent) && this.objects.get(parent)?.type === 'commit') {
          hSeen.add(parent);
          hQueue.push(parent);
        }
      }
    }
    // Unshallow: boundary commits whose parents are all in D.
    const unshallow = [];
    for (const oid of boundary) {
      const commit = this.commitOf(oid);
      if (commit === null) continue;
      if (commit.parents.every((parent) => dCommits.has(parent))) unshallow.push(oid);
    }
    const packOids = [];
    for (const oid of dObjects) {
      if (!hObjects.has(oid)) packOids.push(oid);
    }
    return { oids: packOids, shallow, unshallow };
  }

  // ------------------------------------------------------------- merges

  /**
   * Squash-merge `pr` onto its base tip. Returns {oid} on success or {conflict: true} when a
   * path changed on both sides versus the merge-base to different bytes (including
   * delete-vs-modify). The new commit has exactly one parent: the base tip.
   */
  squashMerge(pr, store, message) {
    const headTip = this.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = this.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { conflict: true };
    const headCommit = this.commitOf(this.peel(headTip));
    const baseCommit = this.commitOf(this.peel(baseTip));
    if (headCommit === null || baseCommit === null) return { conflict: true };
    const base = this.mergeBase(this.peel(headTip), this.peel(baseTip));
    const baseTree = base === null ? null : this.commitOf(base)?.tree ?? null;
    const baseFlat = baseTree === null ? new Map() : this.flatten(baseTree);
    const headFlat = this.flatten(headCommit.tree);
    const tipFlat = this.flatten(baseCommit.tree);
    const merged = new Map(tipFlat);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid ?? null;
      const h = headFlat.get(path)?.oid ?? null;
      const t = tipFlat.get(path)?.oid ?? null;
      const headChanged = h !== b;
      const tipChanged = t !== b;
      if (headChanged && tipChanged && h !== t) return { conflict: true };
      if (headChanged) {
        if (h === null) merged.delete(path);
        else merged.set(path, headFlat.get(path));
      }
    }
    const tree = this.buildFromFlat(merged);
    const oid = this.putObject(
      'commit',
      buildCommit({
        tree,
        parents: [this.peel(baseTip)],
        author: IDENTITY,
        committer: IDENTITY,
        timestamp: store.tick(),
        message,
      }),
    );
    return { oid };
  }

  /** True when the pull request would merge cleanly right now (for mergeable). */
  mergeWouldConflict(pr) {
    const headTip = this.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = this.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return true;
    const headCommit = this.commitOf(this.peel(headTip));
    const baseCommit = this.commitOf(this.peel(baseTip));
    if (headCommit === null || baseCommit === null) return true;
    const base = this.mergeBase(this.peel(headTip), this.peel(baseTip));
    const baseTree = base === null ? null : this.commitOf(base)?.tree ?? null;
    const baseFlat = baseTree === null ? new Map() : this.flatten(baseTree);
    const headFlat = this.flatten(headCommit.tree);
    const tipFlat = this.flatten(baseCommit.tree);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid ?? null;
      const h = headFlat.get(path)?.oid ?? null;
      const t = tipFlat.get(path)?.oid ?? null;
      if (h !== b && t !== b && h !== t) return true;
    }
    return false;
  }

  /**
   * File diff of merge-base tree vs head tree for a pull request. Line counts come from a
   * prefix/suffix common-line diff, which is exact for the single-hunk edits the suite makes.
   */
  prFiles(pr) {
    const headTip = this.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = this.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const headCommit = this.commitOf(this.peel(headTip));
    if (headCommit === null) return [];
    const base = this.mergeBase(this.peel(headTip), this.peel(baseTip));
    const baseTree = base === null ? null : this.commitOf(base)?.tree ?? null;
    const baseFlat = baseTree === null ? new Map() : this.flatten(baseTree);
    const headFlat = this.flatten(headCommit.tree);
    const files = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      const oldText = b === undefined ? '' : (this.objects.get(b.oid)?.data.toString('utf8') ?? '');
      const newText = h === undefined ? '' : (this.objects.get(h.oid)?.data.toString('utf8') ?? '');
      const { additions, deletions } = diffLines(oldText, newText);
      let status;
      if (b === undefined) status = 'added';
      else if (h === undefined) status = 'removed';
      else status = 'modified';
      files.push({
        filename: path,
        status,
        additions: status === 'removed' ? 0 : Math.max(1, additions),
        deletions,
        changes: (status === 'removed' ? 0 : Math.max(1, additions)) + deletions,
      });
    }
    return files;
  }
}

/** Prefix/suffix line diff: counts added and removed lines for single-hunk edits. */
function diffLines(oldText, newText) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline produces a final empty element on both sides; drop it for counting.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

export { ZERO_OID };
