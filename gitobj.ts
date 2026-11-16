// Git objects: hashing, tree/commit/tag encoding and parsing, pack reading and writing.
//
// Every object id in the forge is a real SHA-1 over `<type> <size>\0` + bytes, so the git
// smart-HTTP surface, the REST contents API and merges all agree on the same store. Packs use
// plain (non-delta) entries on write; the reader resolves OFS_DELTA and REF_DELTA entries so any
// valid pack unpacks. Deflate runs at level 1: packs cross loopback, so speed beats size.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value) {
  return typeof value === 'string' && OID_RE.test(value);
}

/** SHA-1 of a git object header + payload, lowercase hex. */
export function hashObject(type, data) {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function oidToBytes(oid) {
  return Buffer.from(oid, 'hex');
}

export function bytesToOid(buffer, offset) {
  return buffer.subarray(offset, offset + 20).toString('hex');
}

// --------------------------------------------------------------------------- trees

/** Sort key for a tree entry: git compares directory names as name + '/'. */
function treeSortKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Encode tree entries (mode, name, oid) into canonical tree bytes. Entries are sorted in place. */
export function buildTree(entries) {
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(oidToBytes(entry.oid));
  }
  return Buffer.concat(parts);
}

/** Parse tree bytes into [{mode, name, oid}]. */
export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = bytesToOid(data, nul + 1);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// --------------------------------------------------------------------------- commits and tags

/** Encode a commit object. `message` is stored with exactly one trailing newline. */
export function buildCommit({ tree, parents, author, committer, timestamp, message }) {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${timestamp} +0000`);
  lines.push(`committer ${committer} ${timestamp} +0000`);
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${text}`, 'utf8');
}

/** Parse a commit object into {tree, parents, author, committer, message}. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header (e.g. gpgsig)
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Encode an annotated tag object. */
export function buildTag({ object, type, tag, tagger, timestamp, message }) {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(
    `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger} ${timestamp} +0000\n\n${text}`,
    'utf8',
  );
}

/** Parse a tag object into {object, type, tag, tagger, message}. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// --------------------------------------------------------------------------- deltas

/** Apply a git delta to a base buffer. Throws on malformed input. */
export function applyDelta(base, delta) {
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint truncated');
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = [];
  let outLength = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset |= delta[offset++] << 24;
      if (op & 0x10) copySize = delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      outLength += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert truncated');
      out.push(delta.subarray(offset, offset + op));
      outLength += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLength !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out, outLength);
}

// --------------------------------------------------------------------------- pack reading

const PACK_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

/**
 * Parse a pack buffer into [{type, data}] with ids computed. Verifies the trailer SHA-1.
 * Throws Error('unpack ...') on any malformation; the caller turns it into an unpack failure.
 */
export function readPack(pack) {
  if (pack.length < 32) throw new Error('unpack: pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('unpack: bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unpack: unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!actual.equals(trailer)) throw new Error('unpack: pack trailer checksum mismatch');
  const bodyEnd = pack.length - 20;

  // First pass: raw entries (offsets, types, inflated delta payloads / plain data).
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= bodyEnd) throw new Error('unpack: pack truncated');
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= bodyEnd) throw new Error('unpack: pack header truncated');
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TYPES[typeNum];
    if (type === undefined) throw new Error(`unpack: unknown pack entry type ${typeNum}`);
    let baseOffset = -1;
    let baseOid = null;
    if (type === 'ofs-delta') {
      if (offset >= bodyEnd) throw new Error('unpack: ofs-delta offset truncated');
      byte = pack[offset++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= bodyEnd) throw new Error('unpack: ofs-delta offset truncated');
        byte = pack[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - base;
      if (baseOffset < 12) throw new Error('unpack: ofs-delta base before pack start');
    } else if (type === 'ref-delta') {
      if (offset + 20 > bodyEnd) throw new Error('unpack: ref-delta base truncated');
      baseOid = bytesToOid(pack, offset);
      offset += 20;
    }
    // The deflated length is not stored in the pack. The fast path inflates the remainder
    // once and reads how many input bytes the engine left unconsumed, then proves the
    // framing with two small validation inflates before trusting it; anything unexpected
    // falls back to the binary search below, so correctness never depends on engine
    // internals. Returns {data, consumed}.
    let entry;
    try {
      entry = inflateEntry(pack, offset, bodyEnd, size);
    } catch {
      throw new Error('unpack: entry inflate failed');
    }
    const { data } = entry;
    offset += entry.consumed;
    if (data.length !== size) throw new Error('unpack: entry size mismatch');
    entries.push({ entryOffset, type, data, baseOffset, baseOid, size });
  }
  if (offset !== bodyEnd) throw new Error('unpack: trailing bytes after last entry');

  // Second pass: resolve deltas (entries are stored by offset for ofs-delta bases).
  const byOffset = new Map();
  const resolved = new Array(entries.length);
  const resolve = (index, guard) => {
    if (resolved[index] !== undefined) return resolved[index];
    if (guard.has(index)) throw new Error('unpack: delta cycle');
    guard.add(index);
    const entry = entries[index];
    let result;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base;
      if (entry.type === 'ofs-delta') {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('unpack: ofs-delta base not in pack');
        base = resolve(baseIndex, guard);
      } else {
        base = null; // ref-delta bases outside the pack are resolved by the caller via lookup
      }
      if (base === null) {
        // Keep the delta unresolved; the caller supplies the base through resolveRefDelta.
        result = { type: 'ref-delta', data: entry.data, baseOid: entry.baseOid, pending: true };
      } else {
        result = { type: base.type, data: applyDelta(base.data, entry.data) };
      }
    } else {
      result = { type: entry.type, data: entry.data };
    }
    guard.delete(index);
    resolved[index] = result;
    return result;
  };
  entries.forEach((entry, index) => byOffset.set(entry.entryOffset, index));
  const objects = [];
  for (let i = 0; i < entries.length; i += 1) {
    const result = resolve(i, new Set());
    if (result.pending) {
      objects.push({ type: 'ref-delta', data: result.data, baseOid: result.baseOid, pending: true });
    } else {
      objects.push({ type: result.type, data: result.data });
    }
  }
  return objects;
}

/**
 * Resolve pending ref-delta entries against a base lookup (oid -> {type, data} | undefined).
 * Returns fully resolved [{type, data}] or throws on a missing base.
 */
export function resolveRefDeltas(objects, lookup) {
  const out = [];
  const byOid = new Map();
  for (const object of objects) {
    if (!object.pending) {
      const oid = hashObject(object.type, object.data);
      byOid.set(oid, object);
      out.push(object);
    }
  }
  for (const object of objects) {
    if (!object.pending) continue;
    const base = byOid.get(object.baseOid) ?? lookup(object.baseOid);
    if (base === undefined) throw new Error('unpack: ref-delta base object missing');
    const data = applyDelta(base.data, object.data);
    const resolved = { type: base.type, data };
    byOid.set(hashObject(resolved.type, data), resolved);
    out.push(resolved);
  }
  return out;
}

// Inflate one pack entry starting at `start`, returning its data and deflated length.
// Fast path: a single inflate of the remainder, whose engine reports the unconsumed input
// count; the framing is then proven (the exact slice must reproduce the data, and one byte
// less must fail) before it is trusted. Any surprise falls back to the binary search.
function inflateEntry(pack, start, end, expectedSize) {
  try {
    const whole = inflateSync(pack.subarray(start, end), { info: true });
    const availIn = whole?.engine?._writeState?.[1];
    if (typeof availIn === 'number') {
      const consumed = (end - start) - availIn;
      if (consumed >= 2 && consumed <= end - start && whole.buffer.length === expectedSize) {
        const exact = inflateSync(pack.subarray(start, start + consumed));
        if (exact.equals(whole.buffer)) {
          let minimal = false;
          try {
            inflateSync(pack.subarray(start, start + consumed - 1));
          } catch {
            minimal = true;
          }
          if (minimal) return { data: whole.buffer, consumed };
        }
      }
    }
  } catch {
    // Fall through to the binary search, which is also the error path for corrupt streams.
  }
  const consumed = inflateConsumed(pack, start, end);
  const data = inflateSync(pack.subarray(start, start + consumed));
  return { data, consumed };
}

// Length of the zlib stream starting at `start`: the smallest prefix that inflates.
// inflateSync ignores trailing bytes and throws on truncation, so binary search converges on
// the exact stream end. Entries here are small (<= ~20 KiB), so the O(log n) probes stay cheap.
function inflateConsumed(pack, start, end) {
  let lo = 1;
  let hi = end - start;
  if (hi < 1) throw new Error('unpack: entry inflate failed');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  try {
    inflateSync(pack.subarray(start, start + lo));
  } catch {
    throw new Error('unpack: entry inflate failed');
  }
  return lo;
}

// --------------------------------------------------------------------------- pack writing

const TYPE_NUMBERS = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packEntryHeader(type, size) {
  const typeNum = TYPE_NUMBERS[type];
  const bytes = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Build a pack from [{type, data}] with plain entries, deterministic order (sorted by oid).
 * `deflated` is an optional per-oid cache Map the caller owns (oid -> deflated Buffer).
 */
export function writePack(objects, deflated) {
  const withIds = objects.map((object) => ({ ...object, oid: hashObject(object.type, object.data) }));
  withIds.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(withIds.length, 8);
  parts.push(header);
  for (const object of withIds) {
    parts.push(packEntryHeader(object.type, object.data.length));
    let def = deflated?.get(object.oid);
    if (def === undefined) {
      def = deflateSync(object.data, { level: 1 });
      deflated?.set(object.oid, def);
    }
    parts.push(def);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
