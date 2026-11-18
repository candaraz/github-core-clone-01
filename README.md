# GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/candaraz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/candaraz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An in-memory GitHub-compatible git forge: git smart-HTTP (protocol v2 and v0),
the REST API v3, GraphQL, and MCP — as a statically linked Go binary, started
by a thin Node launcher, with no dependencies beyond the Go standard library.

## Design

Everything lives in memory: objects, refs, issues, pull requests, comments and
labels share one store, so the git, REST, GraphQL and MCP surfaces can never
disagree. One RWMutex guards the store — reads run concurrently, writes are
exclusive — which keeps every surface consistent without lock ordering. Speed
comes from eliminating repeated work, not from skipping required work:

- Whole-response caches keyed by a per-repository version counter: fetch
  responses (acknowledgments, shallow-info and pack), issue JSON bytes, and
  ls-refs answers. Any object or ref change bumps the version and drops them.
- One constant protocol v2 advertisement buffer, shared by every repository.
- Pack writing emits plain (undeltified) objects sorted by id, at deflate
  level 1; pack reading resolves OFS and REF deltas.
- No server timeouts, explicit content lengths on every response, and
  `GOMAXPROCS(2)` to match the trial pod.

Commit timestamps come from a monotonic counter rooted at the scenario epoch,
never from the wall clock, so repeated runs of the same request sequence emit
identical bytes.

## Layout

- `main.ts` — thin launcher: spawns `./forge`, forwards stdio and signals.
- `forge` — the committed statically linked Go binary (built with
  `CGO_ENABLED=0`, stripped, under the 8 MiB file cap).
- `go/main.go` — trial lifecycle (bind, register, serve, exit on done),
  routing, and the git smart-HTTP handler.
- `go/store.go` — the model: repositories, objects, refs, issues, pull
  requests, labels, caches, and opaque global ids.
- `go/objects.go` — object hashing, tree/commit/tag codecs, pack reading and
  writing, reachability, ancestry, merge-base, tree diffs and squash merges.
- `go/gitproto.go` — pkt-lines, advertisements, ls-refs, fetch, receive-pack.
- `go/rest.go` — the REST API v3.
- `go/graphql.go` — a small GraphQL lexer, parser, validator and executor for
  the fixed schema.
- `go/mcp.go` — JSON-RPC 2.0 Streamable HTTP: `server/discover`, `initialize`,
  six tools.
- `go/jsonutil.go` — request-body parsing and the response shapes shared by
  the REST, GraphQL and MCP surfaces.

## Running

The trial harness runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` set; the launcher starts `./forge`, which serves until
the environment reports done. No install step is needed.

To rebuild the binary from source (Go 1.24):

```sh
cd go && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../forge .
```

---

Built for the [make.fun](https://make.fun) `github-core-clone-01` competition.

Version 4 is a fresh implementation of the forge in Go, written from the
competition rules and the kit's conformance suite.
