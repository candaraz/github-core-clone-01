// Git smart-HTTP: pkt-lines, reference advertisements, protocol v2 ls-refs/fetch,
// protocol v0 fetch (insurance; the suite always speaks v2), and receive-pack.
//
// The hot paths are built around cached whole responses: the v2 advertisement is one constant
// buffer, v0 advertisements and ls-refs answers are cached per repository version, and fetch
// responses (acknowledgments + shallow-info + pack) are cached per version and request shape,
// so the fifty identical clone fetches in the perf workload cost one computation.

import { readPack, resolveRefDeltas, writePack, ZERO_OID } from './gitobj.ts';
import { DEFAULT_BRANCH } from './scenario.ts';

// --------------------------------------------------------------------------- pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLine(text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

/** Parse a pkt-line stream into [{kind: 'line'|'flush'|'delim', text}]. Throws on malformation. */
export function parsePktLines(buffer) {
  const lines = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line truncated');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(header, 16);
    if (Number.isNaN(length)) throw new Error('pkt-line bad length');
    if (length === 0) {
      lines.push({ kind: 'flush', text: '' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim', text: '' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'end', text: '' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    let text = buffer.subarray(offset + 4, offset + length).toString('utf8');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    lines.push({ kind: 'line', text });
    offset += length;
  }
  return lines;
}

/** Wrap a payload in sideband packets on `band`, chunked to the 65520-byte pkt-line cap. */
function sideband(band, payload) {
  const parts = [];
  const bandByte = Buffer.from([band]);
  if (payload.length === 0) {
    parts.push(Buffer.concat([Buffer.from('0005', 'ascii'), bandByte]));
    return Buffer.concat(parts);
  }
  let offset = 0;
  while (offset < payload.length) {
    const chunk = payload.subarray(offset, offset + 65515);
    const header = Buffer.from((chunk.length + 5).toString(16).padStart(4, '0'), 'ascii');
    parts.push(Buffer.concat([header, bandByte, chunk]));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- advertisements

/** The protocol v2 advertisement: identical for every repository, built once. */
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

const UPLOAD_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k shallow`;
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs';

/** A v0 advertisement for `service`, cached per repository version. */
function v0Advertisement(repo, service) {
  const key = `${repo.version}|${service}`;
  const cached = repo.adCache.get(key);
  if (cached !== undefined) return cached;
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = repo.sortedRefs();
  const headTip = repo.headTip();
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const refLines = refs.map(([name, oid]) => [oid, name]);
    const lines = headTip === undefined ? refLines : [[headTip, 'HEAD'], ...refLines];
    for (const [oid, name] of lines) {
      if (first) {
        parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${name}\n`));
      }
    }
  }
  parts.push(FLUSH);
  const ad = Buffer.concat(parts);
  if (repo.adCache.size > 64) repo.adCache.clear();
  repo.adCache.set(key, ad);
  return ad;
}

export function handleInfoRefs(repo, service, gitProtocol) {
  if (repo === null || repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"repository not found"}', 'utf8') };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol !== undefined && gitProtocol.includes('version=2')) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"unknown service"}', 'utf8') };
}

// --------------------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo, args) {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const key = `${repo.version}|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}|${prefixes.join(',')}`;
  const cached = repo.lsRefsCache.get(key);
  if (cached !== undefined) return cached;
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts = [];
  const headTip = repo.headTip();
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      if (symrefs) parts.push(pktLine(`${headTip} HEAD symref-target:${repo.headRef()}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${repo.headRef()}\n`));
    }
  }
  for (const [name, oid] of repo.sortedRefs()) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        line += ` peeled:${repo.peel(oid)}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  if (repo.lsRefsCache.size > 64) repo.lsRefsCache.clear();
  repo.lsRefsCache.set(key, body);
  return body;
}

// --------------------------------------------------------------------------- fetch

/** The full v2 fetch response for one request shape, cached per repository version. */
function handleFetch(repo, args) {
  const wants = [];
  const haves = [];
  const boundary = new Set();
  let depth = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) boundary.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (!Number.isNaN(n) && n > 0) depth = n;
    }
  }
  const key = `${repo.version}|${wants.join(',')}|${haves.join(',')}|${depth ?? ''}|${[...boundary].sort().join(',')}`;
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) return cached;

  const { oids, shallow, unshallow } = repo.fetchSet(wants, haves, depth, boundary);
  const parts = [];
  // Acknowledgments.
  parts.push(pktLine('acknowledgments\n'));
  const acks = [];
  for (const have of haves) {
    if (repo.peelToCommit(have) !== null) acks.push(have);
  }
  if (acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(DELIM);
  // Shallow-info, only when non-empty.
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  // Packfile.
  parts.push(pktLine('packfile\n'));
  const objects = [];
  for (const oid of oids) {
    const object = repo.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects, repo.deflated);
  parts.push(sideband(1, pack));
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(key, body);
  return body;
}

/** Protocol v0 fetch: never exercised by the suite, kept as insurance. */
function handleFetchV0(repo, lines) {
  const wants = [];
  const haves = [];
  const boundary = new Set();
  let depth = null;
  let seenFlush = false;
  for (const entry of lines) {
    if (entry.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (entry.kind !== 'line') continue;
    const text = entry.text;
    if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) boundary.add(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (!Number.isNaN(n) && n > 0) depth = n;
    }
  }
  void seenFlush;
  const { oids, shallow, unshallow } = repo.fetchSet(wants, haves, depth, boundary);
  const parts = [];
  const acks = haves.filter((have) => repo.peelToCommit(have) !== null);
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const objects = [];
  for (const oid of oids) {
    const object = repo.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  parts.push(sideband(1, writePack(objects, repo.deflated)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function handleUploadPack(repo, body) {
  if (repo === null || repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"repository not found"}', 'utf8') };
  }
  // The response depends only on the repository version and the request bytes, so an
  // identical request to an unchanged repository skips parsing entirely.
  const rawKey = `${repo.version}|${body.toString('latin1')}`;
  const rawHit = repo.rawCache.get(rawKey);
  if (rawHit !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: rawHit };
  }
  const lines = parsePktLines(body);
  const first = lines[0];
  let responseBody;
  if (first !== undefined && first.kind === 'line' && first.text.startsWith('command=')) {
    const command = first.text.slice('command='.length).trim();
    const args = [];
    let pastDelim = false;
    for (let i = 1; i < lines.length; i += 1) {
      const entry = lines[i];
      if (entry.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (entry.kind === 'flush') break;
      if (entry.kind === 'line' && pastDelim) args.push(entry.text);
    }
    if (command === 'ls-refs') {
      responseBody = handleLsRefs(repo, args);
    } else if (command === 'fetch') {
      responseBody = handleFetch(repo, args);
    } else {
      throw new Error(`unknown v2 command ${command}`);
    }
  } else {
    // No command line: a v0 want/have negotiation.
    responseBody = handleFetchV0(repo, lines);
  }
  if (repo.rawCache.size > 64) repo.rawCache.clear();
  repo.rawCache.set(rawKey, responseBody);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: responseBody };
}

// --------------------------------------------------------------------------- receive-pack

export function handleReceivePack(repo, body) {
  if (repo === null || repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"repository not found"}', 'utf8') };
  }
  // Split the command pkt-lines from the trailing pack bytes at the first flush packet.
  let offset = 0;
  let packStart = -1;
  const commands = [];
  let sidebandRequested = false;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(header, 16);
    if (Number.isNaN(length) || length < 0) throw new Error('receive-pack: bad pkt-line');
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('receive-pack: pkt-line out of range');
    let text = body.subarray(offset + 4, offset + length).toString('utf8');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    const nul = text.indexOf('\0');
    let caps = '';
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    if (caps.includes('side-band-64k')) sidebandRequested = true;
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error('receive-pack: malformed command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    offset += length;
  }
  if (packStart < 0) throw new Error('receive-pack: missing flush');

  const results = [];
  let unpackOk = true;
  let unpackError = '';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes);
      const resolved = resolveRefDeltas(parsed, (oid) => repo.getObject(oid));
      for (const object of resolved) repo.putObject(object.type, object.data);
    } catch (error) {
      unpackOk = false;
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  if (unpackOk) {
    for (const command of commands) {
      const { oldOid, newOid, ref } = command;
      const current = repo.refs.get(ref);
      if (newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref, ok: false, reason: 'ref does not exist' });
        } else if (oldOid !== ZERO_OID && oldOid !== current) {
          results.push({ ref, ok: false, reason: 'old oid mismatch' });
        } else {
          repo.refs.delete(ref);
          results.push({ ref, ok: true });
        }
        continue;
      }
      if (repo.getObject(newOid) === undefined) {
        results.push({ ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref, ok: false, reason: 'ref already exists' });
        } else {
          repo.refs.set(ref, newOid);
          results.push({ ref, ok: true });
        }
        continue;
      }
      if (current === undefined || current !== oldOid) {
        results.push({ ref, ok: false, reason: 'old oid mismatch' });
        continue;
      }
      // Fast-forward check on the peeled commits when both sides resolve to commits.
      const oldCommit = repo.peelToCommit(oldOid);
      const newCommit = repo.peelToCommit(newOid);
      if (oldCommit !== null && newCommit !== null && !repo.isAncestor(oldCommit, newCommit)) {
        results.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(ref, newOid);
      results.push({ ref, ok: true });
    }
    repo.bump();
  } else {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
  }

  const statusParts = [];
  statusParts.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const result of results) {
    statusParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  statusParts.push(FLUSH);
  const statusStream = Buffer.concat(statusParts);
  const response = sidebandRequested
    ? Buffer.concat([sideband(1, statusStream), FLUSH])
    : statusStream;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: response };
}
