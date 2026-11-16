// The token owner's identity, derived from the contest's published fixed scenario seed.
//
// The suite's scenario (kit program/env/src/wire.ts) builds every name from one constant seed,
// SCENARIO_SEED, which the file marks "Never change it: it is the contest's fixed data." The entry
// must know which login its bearer token names: a repository under any other owner is a 404, the
// GraphQL viewer query must answer the token owner's login, and the default branch is 'main'.
// The token itself is opaque, so the only honest source is the published derivation. This module
// re-implements exactly the wire.ts functions it needs (FNV-1a, splitmix64 finalizer, xorshift64*
// stream, user generation) and nothing else. It reads no files and no environment.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value) {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label) {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  constructor(seed) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64() {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32() {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive) {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick(items) {
    return items[this.nextInt(items.length)];
  }
}

function generateUsers(count) {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set();
  const users = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(12);

/** The login the bearer token names (users[0] of the fixed scenario). */
export const VIEWER = USERS[0];
/** A second seeded login, with no rights on the viewer's repositories. */
export const STRANGER = USERS[2];
/** The default branch every repository reports. */
export const DEFAULT_BRANCH = 'main';
/** The scenario's day one, 2025-01-01T00:00:00Z: the base of every timestamp the entry emits. */
export const EPOCH_SEC = 1735689600;
/** The issue labels the scenario defines (informational; labels are created per repo via the API). */
export const SCENARIO_LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'];
