// Git smart HTTP: info/refs advertisements (v0 + protocol v2), ls-refs,
// fetch (v2 + v0), and receive-pack. Implements the wire formats from the
// git protocol specifications; no git binary involved.

import {
  DELIM_PKT,
  FLUSH_PKT,
  ZERO_OID,
  buildPack,
  commitDepths,
  isAncestor,
  objectClosure,
  parseAllPktLines,
  parseCommit,
  parsePack,
  parsePktStream,
  parseTag,
  pktLine,
  shallowHeld,
  sidebandPack,
  type ObjectStore,
} from './objects.ts';
import type { Forge, Repo } from './store.ts';

const AGENT_NAME = 'forge/1.0';

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow agent=${AGENT_NAME}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs agent=${AGENT_NAME}`;

/** Static protocol-v2 capability advertisement, encoded once. */
let v2Advertisement: Buffer | null = null;
function v2AdvertisementBytes(): Buffer {
  if (!v2Advertisement) {
    v2Advertisement = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('fetch=shallow\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${AGENT_NAME}\n`),
      FLUSH_PKT,
    ]);
  }
  return v2Advertisement;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResponse(status: number, text: string): GitResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

/** Follow tag objects until a non-tag object; cycle-guarded. */
export function peelToNonTag(store: ObjectStore, oid: string): string {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = store.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.body).object;
  }
}

interface RefLine {
  oid: string;
  name: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  for (const [name, oid] of repo.refs) lines.push({ oid, name });
  lines.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return lines;
}

function buildV0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.headTip();
    let first = true;
    if (head) {
      parts.push(pktLine(`${head} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = peelToNonTag(repo.objects, ref.oid);
      if (peeled !== ref.oid && ref.name.startsWith('refs/tags/')) {
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantUnborn = args.includes('unborn');
  const wantSymrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const lines: string[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (wantUnborn && matches('HEAD')) lines.push('unborn HEAD symref-target:refs/heads/main');
  } else {
    const head = repo.headTip();
    if (head && matches('HEAD')) {
      let line = `${head} HEAD`;
      if (wantSymrefs) line += ' symref-target:refs/heads/main';
      if (wantPeel) {
        const peeled = peelToNonTag(repo.objects, head);
        if (peeled !== head) line += ` peeled:${peeled}`;
      }
      lines.push(line);
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (wantPeel) {
        const peeled = peelToNonTag(repo.objects, ref.oid);
        if (peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
      lines.push(line);
    }
  }
  const parts = lines.map((line) => pktLine(line + '\n'));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch (shared pack computation for v2 and v0)
// ---------------------------------------------------------------------------

interface FetchPlan {
  packOids: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  hasNak: boolean;
}

function planFetch(repo: Repo, wants: string[], haves: string[], shallowList: string[], depth: number | null): FetchPlan {
  const store = repo.objects;
  // Peel tag wants to commits, but keep every tag object in the chain: a
  // wanted tag is itself part of the transferred pack.
  const commitWants: string[] = [];
  const directObjects = new Set<string>();
  for (const want of wants) {
    const obj = store.get(want);
    if (obj && obj.type === 'tag') {
      let current = want;
      const seen = new Set<string>();
      while (!seen.has(current)) {
        seen.add(current);
        const tagObj = store.get(current);
        if (!tagObj || tagObj.type !== 'tag') break;
        directObjects.add(current);
        current = parseTag(tagObj.body).object;
      }
      const peeled = peelToNonTag(store, want);
      const target = store.get(peeled);
      if (target && target.type === 'commit') commitWants.push(peeled);
      else if (store.has(peeled)) directObjects.add(peeled);
    } else if (obj && obj.type === 'commit') {
      commitWants.push(want);
    } else if (store.has(want)) {
      directObjects.add(want);
    }
  }
  const depths = commitDepths(store, commitWants);
  const included = new Set<string>();
  const boundary: string[] = [];
  for (const [oid, d] of depths) {
    if (depth === null || d <= depth) {
      included.add(oid);
      if (depth !== null && d === depth) {
        const info = parseCommit((store.get(oid) as { body: Buffer }).body);
        if (info.parents.length > 0) boundary.push(oid);
      }
    }
  }
  const unshallow: string[] = [];
  for (const oid of shallowList) {
    if (!included.has(oid)) continue;
    const d = depths.get(oid);
    if (depth === null || (d !== undefined && d < depth)) unshallow.push(oid);
  }
  const excluded = new Set<string>();
  const shallowSet = new Set(shallowList.map((oid) => peelToNonTag(store, oid)));
  for (const have of haves) {
    const peeled = peelToNonTag(store, have);
    if (store.get(peeled)?.type !== 'commit') continue;
    if (shallowSet.has(peeled)) {
      // A shallow boundary is a cutoff, not fully-held history: the client
      // holds the commit and its tree, but none of its ancestors.
      for (const held of shallowHeld(store, peeled)) excluded.add(held);
    } else {
      const haveDepths = commitDepths(store, [peeled]);
      for (const oid of objectClosure(store, haveDepths.keys())) excluded.add(oid);
    }
  }
  for (const oid of shallowList) {
    for (const held of shallowHeld(store, oid)) excluded.add(held);
  }
  const wanted = objectClosure(store, included);
  for (const oid of directObjects) wanted.add(oid);
  const packOids: string[] = [];
  for (const oid of wanted) {
    if (!excluded.has(oid)) packOids.push(oid);
  }
  const acks: string[] = [];
  for (const have of haves) {
    const peeled = peelToNonTag(store, have);
    if (depths.has(peeled)) acks.push(have);
  }
  return { packOids, shallow: boundary, unshallow, acks, hasNak: haves.length > 0 && acks.length === 0 };
}

function buildFetchResponseV2(repo: Repo, wants: string[], haves: string[], shallowList: string[], depth: number | null): Buffer {
  const key = JSON.stringify({ w: [...wants].sort(), h: [...haves].sort(), s: [...shallowList].sort(), d: depth });
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const plan = planFetch(repo, wants, haves, shallowList, depth);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    if (plan.hasNak) parts.push(pktLine('NAK\n'));
    parts.push(DELIM_PKT);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(repo.objects, plan.packOids);
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH_PKT);
  const response = Buffer.concat(parts);
  if (repo.packCache.size >= 500) {
    const oldest = repo.packCache.keys().next().value;
    if (oldest !== undefined) repo.packCache.delete(oldest);
  }
  repo.packCache.set(key, response);
  return response;
}

function buildFetchResponseV0(repo: Repo, wants: string[], haves: string[], shallowList: string[], depth: number | null): Buffer {
  const plan = planFetch(repo, wants, haves, shallowList, depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const pack = buildPack(repo.objects, plan.packOids);
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Upload-pack POST dispatch (v2 vs v0 by request shape)
// ---------------------------------------------------------------------------

function parseV2Command(packets: ReturnType<typeof parseAllPktLines>): { command: string; args: string[] } | null {
  const lines: string[] = [];
  let seenDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) lines.push(text);
    else args.push(text);
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (!commandLine) return null;
  return { command: commandLine.slice('command='.length), args };
}

function handleUploadPack(repo: Repo, body: Buffer): GitResponse {
  const packets = parseAllPktLines(body);
  const v2 = parseV2Command(packets);
  if (v2) {
    if (v2.command === 'ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, v2.args) };
    }
    if (v2.command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowList: string[] = [];
      let depth: number | null = null;
      for (const arg of v2.args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallowList.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7).trim(), 10);
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: buildFetchResponseV2(repo, wants, haves, shallowList, depth) };
    }
    return textResponse(400, `unknown command ${v2.command}`);
  }
  // Protocol v0 fetch: wants/haves/shallow/deepen/done across all data packets.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowList: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    text = text.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowList.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7).trim(), 10);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: buildFetchResponseV0(repo, wants, haves, shallowList, depth) };
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  let parsed;
  try {
    parsed = parsePktStream(body);
  } catch {
    return textResponse(400, 'malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !/^[0-9a-f]{40}$/.test(parts[0]) || !/^[0-9a-f]{40}$/.test(parts[1])) {
      return textResponse(400, 'malformed receive-pack command');
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) return textResponse(400, 'no commands');

  // Store the pushed pack's objects first; validate via recomputed SHAs.
  if (parsed.remainder.length > 0) {
    let imported;
    try {
      imported = parsePack(parsed.remainder);
    } catch {
      return textResponse(400, 'malformed pack');
    }
    for (const [oid, obj] of imported) repo.objects.putRaw(oid, obj.type, obj.body);
  }

  const results: string[] = [];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    const current = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push(`ng ${ref} remote ref does not exist`);
      } else {
        repo.refs.delete(ref);
        results.push(`ok ${ref}`);
      }
      continue;
    }
    if (!repo.objects.has(newOid)) {
      results.push(`ng ${ref} object not found`);
      continue;
    }
    if (oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push(`ng ${ref} already exists`);
      } else {
        repo.refs.set(ref, newOid);
        results.push(`ok ${ref}`);
      }
      continue;
    }
    // Update: fast-forward required.
    if (current === undefined) {
      results.push(`ng ${ref} remote ref does not exist`);
    } else if (current !== oldOid) {
      results.push(`ng ${ref} non-fast-forward`);
    } else if (!isAncestor(repo.objects, oldOid, newOid)) {
      results.push(`ng ${ref} non-fast-forward`);
    } else {
      repo.refs.set(ref, newOid);
      results.push(`ok ${ref}`);
    }
  }

  const inner: Buffer[] = [pktLine('unpack ok\n')];
  for (const result of results) inner.push(pktLine(result + '\n'));
  inner.push(FLUSH_PKT);
  const framed = sidebandPack(Buffer.concat(inner));
  framed.push(FLUSH_PKT);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(framed) };
}

// ---------------------------------------------------------------------------
// Router entry point
// ---------------------------------------------------------------------------

export interface GitRequest {
  method: string;
  owner: string;
  repoName: string;
  tail: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Handle a request whose path matched /{owner}/{repo}.git/... Returns null
 * when the tail is not a smart-HTTP endpoint (caller then 404s).
 */
export function handleGit(forge: Forge, req: GitRequest): GitResponse | null {
  const repo = forge.repoFor(req.owner, req.repoName);
  if (!repo) return textResponse(404, 'repository not found');

  if (req.method === 'GET' && req.tail === '/info/refs') {
    const service = req.query.get('service') ?? '';
    const protocolHeader = req.headers['git-protocol'];
    const wantsV2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
    if (service === 'git-upload-pack') {
      if (wantsV2) {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2AdvertisementBytes() };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: buildV0Advertisement(repo, service, V0_UPLOAD_CAPS) };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: buildV0Advertisement(repo, service, V0_RECEIVE_CAPS) };
    }
    return textResponse(400, 'unknown service');
  }

  if (req.method === 'POST' && req.tail === '/git-upload-pack') {
    try {
      return handleUploadPack(repo, req.body);
    } catch {
      return textResponse(400, 'malformed upload-pack request');
    }
  }

  if (req.method === 'POST' && req.tail === '/git-receive-pack') {
    return handleReceivePack(repo, req.body);
  }

  return null;
}
