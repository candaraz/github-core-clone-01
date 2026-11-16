# GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/candaraz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/candaraz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An in-memory GitHub-compatible git forge: git smart-HTTP (protocol v2 and v0),
the REST API v3, GraphQL, and MCP — on Node.js with no dependencies beyond the
standard library.

## Design

Everything lives in memory: objects, refs, issues, pull requests, comments and
labels share one store, so the git, REST, GraphQL and MCP surfaces can never
disagree. Speed comes from eliminating repeated work, not from skipping
required work:

- Whole-response caches keyed by a per-repository version counter: fetch
  responses (acknowledgments, shallow-info and pack), issue JSON bytes, v0
  advertisements and ls-refs answers.
- One constant protocol v2 advertisement buffer, shared by every repository.
- Per-object deflated-bytes cache for pack writing, at deflate level 1.
- Plain JavaScript in `.ts` files, run by Node's type stripping; no build step,
  no packages, no native addons.

Timestamps come from a monotonic counter rooted at the scenario epoch, never
from the wall clock, so repeated runs of the same request sequence emit
identical bytes.

## Layout

- `main.ts` — trial lifecycle: bind, register, serve, exit on done.
- `app.ts` — HTTP routing, bearer-token authentication, body reading.
- `store.ts` — the model and git graph operations (ancestry, merge-base,
  fetch object sets, squash merges).
- `gitobj.ts` — object hashing, tree/commit/tag codecs, pack reading and writing.
- `gitproto.ts` — pkt-lines, advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — the REST API v3.
- `graphql.ts` — a small GraphQL lexer, parser and executor for the fixed schema.
- `mcp.ts` — JSON-RPC 2.0 Streamable HTTP: `server/discover`, `initialize`, six tools.
- `scenario.ts` — the token owner's identity, derived from the published fixed seed.

## Running

The trial harness runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` set. No install step is needed.

---

Built for the [make.fun](https://make.fun) `github-core-clone-01` competition.
