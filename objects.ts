// Git object model, pack codec, and pkt-line framing.
// Pure functions over Buffers plus a small in-memory object store.
// No git binary, no wall clock, no randomness anywhere in this module.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  type: ObjType;
  body: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, body]));
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n`;
  return Buffer.concat([Buffer.from(head + '\n', 'utf8'), Buffer.from(info.message, 'utf8')]);
}

export function identityLine(epochSeconds: number): string {
  return `Forge <forge@localhost> ${epochSeconds} +0000`;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(0x20, i);
    if (space === -1) throw new Error('malformed tree: no space');
    const nul = body.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > body.length) throw new Error('malformed tree: truncated entry');
    const mode = body.toString('ascii', i, space);
    const name = body.toString('utf8', space + 1, nul);
    const oid = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? entry.name + '/' : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(body: Buffer): TagInfo {
  const text = body.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Object store
// ---------------------------------------------------------------------------

export class ObjectStore {
  private objects = new Map<string, GitObject>();
  private deflated = new Map<string, Buffer>();

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  put(type: ObjType, body: Buffer): string {
    const oid = hashObject(type, body);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, body });
    return oid;
  }

  putRaw(oid: string, type: ObjType, body: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, body });
  }

  /** Deflated form of an object's body, cached: pack building reuses it. */
  deflateFor(oid: string): Buffer {
    let cached = this.deflated.get(oid);
    if (cached) return cached;
    const obj = this.objects.get(oid);
    if (!obj) throw new Error(`deflateFor: missing object ${oid}`);
    cached = deflateSync(obj.body, { level: 6 });
    this.deflated.set(oid, cached);
    return cached;
  }

  get size(): number {
    return this.objects.size;
  }
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

function readSizeVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= data.length) throw new Error('delta varint overruns buffer');
    const byte = data[i++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readSizeVarint(delta, 0);
  if (source.value !== base.length) throw new Error('delta source size mismatch');
  const target = readSizeVarint(delta, source.next);
  const parts: Buffer[] = [];
  let produced = 0;
  let i = target.next;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[i++];
      if (op & 0x02) offset |= delta[i++] << 8;
      if (op & 0x04) offset |= delta[i++] << 16;
      if (op & 0x08) offset |= delta[i++] << 24;
      if (op & 0x10) size = delta[i++];
      if (op & 0x20) size |= delta[i++] << 8;
      if (op & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy overruns base');
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      if (i + op > delta.length) throw new Error('delta insert overruns stream');
      parts.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== target.value) throw new Error('delta target size mismatch');
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Pack reading
// ---------------------------------------------------------------------------

interface RawPackEntry {
  start: number;
  code: number;
  size: number;
  baseOffset: number | null;
  baseOid: string | null;
  data: Buffer;
}

/**
 * Inflate exactly one zlib stream starting at `start`. A single inflateSync
 * call with `info: true` reports the consumed input length via the engine's
 * bytesWritten (trailing bytes are ignored, truncation throws), so no
 * prefix search is needed. The caller verifies the entries end exactly at
 * the pack trailer, which catches any accounting drift.
 */
function inflateOne(buf: Buffer, start: number, expectedSize: number): { out: Buffer; consumed: number } {
  const maxLen = buf.length - start;
  if (maxLen <= 0) throw new Error('pack entry overruns buffer');
  const result = inflateSync(buf.subarray(start), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (result.buffer.length !== expectedSize) throw new Error('pack entry size mismatch');
  const consumed = result.engine.bytesWritten;
  if (!Number.isFinite(consumed) || consumed <= 0 || consumed > maxLen) {
    throw new Error('pack entry inflate accounting failed');
  }
  return { out: result.buffer, consumed };
}

function readPackHeader(data: Buffer, offset: number): { code: number; size: number; next: number } {
  let byte = data[offset];
  if (byte === undefined) throw new Error('pack header overruns buffer');
  const code = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let i = offset + 1;
  while (byte & 0x80) {
    byte = data[i];
    if (byte === undefined) throw new Error('pack header overruns buffer');
    size |= (byte & 0x7f) << shift;
    shift += 7;
    i++;
  }
  return { code, size, next: i };
}

function readOfsOffset(data: Buffer, offset: number): { value: number; next: number } {
  let byte = data[offset];
  if (byte === undefined) throw new Error('ofs-delta offset overruns buffer');
  let value = byte & 0x7f;
  let i = offset + 1;
  while (byte & 0x80) {
    byte = data[i];
    if (byte === undefined) throw new Error('ofs-delta offset overruns buffer');
    value = ((value + 1) << 7) | (byte & 0x7f);
    i++;
  }
  return { value, next: i };
}

/** Parse a pack file into resolved objects. Throws on any malformation. */
export function parsePack(pack: Buffer): Map<string, GitObject> {
  const result = new Map<string, GitObject>();
  if (pack.length === 0) return result;
  if (pack.length < 32) throw new Error('pack too small');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack magic mismatch');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(actual)) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  let offset = 12;
  for (let n = 0; n < count; n++) {
    const start = offset;
    const header = readPackHeader(pack, offset);
    offset = header.next;
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (header.code === 6) {
      const ofs = readOfsOffset(pack, offset);
      baseOffset = start - ofs.value;
      if (baseOffset < 12) throw new Error('ofs-delta base before pack start');
      offset = ofs.next;
    } else if (header.code === 7) {
      if (offset + 20 > pack.length) throw new Error('ref-delta base overruns buffer');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!(header.code in CODE_TYPE)) {
      throw new Error(`unknown pack entry type ${header.code}`);
    }
    const inflated = inflateOne(pack, offset, header.size);
    offset += inflated.consumed;
    raw.push({ start, code: header.code, size: header.size, baseOffset, baseOid, data: inflated.out });
  }
  if (offset !== pack.length - 20) throw new Error('pack entries do not end at the trailer');

  // Resolve in pack order: plain objects first, then OFS deltas (bases always
  // precede them), then REF deltas in repeated passes until all resolve.
  const byOffset = new Map<number, GitObject>();
  const pendingRef: RawPackEntry[] = [];
  for (const entry of raw) {
    if (entry.code === 6) {
      const base = byOffset.get(entry.baseOffset as number);
      if (!base) throw new Error('ofs-delta base not yet resolved');
      const body = applyDelta(base.body, entry.data);
      const obj: GitObject = { type: base.type, body };
      const oid = hashObject(obj.type, obj.body);
      byOffset.set(entry.start, obj);
      result.set(oid, obj);
    } else if (entry.code === 7) {
      pendingRef.push(entry);
    } else {
      const obj: GitObject = { type: CODE_TYPE[entry.code], body: entry.data };
      const oid = hashObject(obj.type, obj.body);
      byOffset.set(entry.start, obj);
      result.set(oid, obj);
    }
  }
  let progress = true;
  while (pendingRef.length > 0 && progress) {
    progress = false;
    for (let i = pendingRef.length - 1; i >= 0; i--) {
      const entry = pendingRef[i];
      const base = result.get(entry.baseOid as string);
      if (!base) continue;
      const body = applyDelta(base.body, entry.data);
      const obj: GitObject = { type: base.type, body };
      const oid = hashObject(obj.type, obj.body);
      byOffset.set(entry.start, obj);
      result.set(oid, obj);
      pendingRef.splice(i, 1);
      progress = true;
    }
  }
  if (pendingRef.length > 0) throw new Error('ref-delta base missing from pack');
  return result;
}

// ---------------------------------------------------------------------------
// Pack writing
// ---------------------------------------------------------------------------

function packEntryHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let remaining = size >>> 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a pack version 2 containing the given objects, plain (no deltas). */
export function buildPack(store: ObjectStore, oids: string[]): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const oid of sorted) {
    const obj = store.get(oid);
    if (!obj) throw new Error(`buildPack: missing object ${oid}`);
    const deflated = store.deflateFor(oid);
    parts.push(packEntryHeader(TYPE_CODE[obj.type], obj.body.length));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/** BFS depths from the want commits (wants = depth 1, shortest path). */
export function commitDepths(store: ObjectStore, wants: string[]): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const obj = store.get(want);
    if (obj && obj.type === 'commit' && !depths.has(want)) {
      depths.set(want, 1);
      queue.push(want);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    const depth = depths.get(oid) as number;
    const obj = store.get(oid) as GitObject;
    const info = parseCommit(obj.body);
    for (const parent of info.parents) {
      if (!depths.has(parent) && store.get(parent)?.type === 'commit') {
        depths.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return depths;
}

function treeClosureInto(store: ObjectStore, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    out.add(oid);
    for (const entry of parseTree(obj.body)) {
      if (entry.mode === '160000') continue; // gitlink: not stored locally
      if (entry.mode === '40000') stack.push(entry.oid);
      else out.add(entry.oid);
    }
  }
}

/** Full object closure of a set of commits: commits + trees + blobs. */
export function objectClosure(store: ObjectStore, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of commits) {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.add(oid);
    treeClosureInto(store, parseCommit(obj.body).tree, out);
  }
  return out;
}

/** Objects a shallow client already holds for a boundary commit: the commit itself plus its tree closure (never its parents). */
export function shallowHeld(store: ObjectStore, commitOid: string): Set<string> {
  const out = new Set<string>([commitOid]);
  const obj = store.get(commitOid);
  if (obj && obj.type === 'commit') treeClosureInto(store, parseCommit(obj.body).tree, out);
  return out;
}

export function isAncestor(store: ObjectStore, maybeAncestor: string, tip: string): boolean {
  if (maybeAncestor === tip) return true;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (parent === maybeAncestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** First common ancestor found by BFS from `b` over the ancestor set of `a`. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    ancestorsA.add(oid);
    for (const parent of parseCommit(obj.body).parents) stackA.push(parent);
  }
  const queue: string[] = [b];
  const seen = new Set<string>([b]);
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    if (ancestorsA.has(oid)) return oid;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Newest-first commit walk from a tip, following first-parent-then-all order via BFS by generation. */
export function walkCommits(store: ObjectStore, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  let head = 0;
  while (head < queue.length && out.length < limit) {
    const oid = queue[head++];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.body).parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface ParsedPkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Parse a pkt-line stream. Stops at the first flush packet and returns the
 * unconsumed remainder (raw pack bytes follow the flush in receive-pack).
 * Throws on malformed framing.
 */
export function parsePktStream(buf: Buffer): { packets: ParsedPkt[]; remainder: Buffer } {
  const packets: ParsedPkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('pkt-line: truncated length header');
    const header = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pkt-line: bad length header');
    const len = parseInt(header, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error('pkt-line: bad packet length');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, remainder: buf.subarray(i) };
}

/** Parse a whole buffer as pkt-lines (no remainder expected). */
export function parseAllPktLines(buf: Buffer): ParsedPkt[] {
  const packets: ParsedPkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('pkt-line: truncated length header');
    const header = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pkt-line: bad length header');
    const len = parseInt(header, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error('pkt-line: bad packet length');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return packets;
}

/** Frame pack bytes as sideband band-1 packets, chunked for safety. */
export function sidebandPack(pack: Buffer, chunkSize = 32767): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += chunkSize) {
    const chunk = pack.subarray(i, Math.min(i + chunkSize, pack.length));
    const framed = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(framed));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}
