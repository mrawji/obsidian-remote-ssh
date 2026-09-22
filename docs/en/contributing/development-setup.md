---
title: Development setup
tags: [contributing, dev]
---

# Development setup

How to get a working dev environment for the plugin and the daemon. Targets a contributor making their first PR; covers macOS, Linux, and Windows + WSL.

## Toolchain

| Tool | Min version | Why |
|---|---|---|
| Node.js | **24.x** (LTS; CI floor is 22.22.2 per `plugin/package.json` `engines.node`) | Plugin build (esbuild), unit tests (jsdom 30 needs 22.22.2+), npm scripts |
| Go | **1.25.x** (per `server/go.mod` + CI) | Daemon binary build |
| Docker + docker compose | any recent | Integration tests use a sandbox sshd container |
| `make` | any | `server/Makefile` orchestrates the Go cross-builds |
| `gh` (GitHub CLI) | recent | PR management; not strictly required but heavily used in our flow |

For Windows: install via WSL2 (Ubuntu 22.04 or newer) — the integration test sshd container assumes a Linux-ish environment.

## First-time clone

```bash
git clone https://github.com/sotashimozono/obsidian-remote-ssh.git
cd obsidian-remote-ssh

# Plugin deps
cd plugin
npm ci

# Verify Go works + binary builds
cd ../server
make build
./bin/obsidian-remote-server --help
```

If `make build` succeeds and the help output renders, your toolchain is good.

## Repo layout

```
obsidian-remote-ssh/
├── plugin/                      # Obsidian plugin (TypeScript)
│   ├── src/
│   │   ├── transport/           # SSH + RPC client
│   │   ├── adapter/             # Obsidian adapter shim
│   │   ├── settings/            # UI for profiles
│   │   ├── ssh/                 # Host-key store, auth resolver
│   │   └── ui/                  # Status bar, modals, terminal pane
│   ├── tests/                   # vitest unit + integration suites
│   ├── e2e/                     # Playwright tests against real Obsidian
│   ├── scripts/                 # build-server.mjs, bump-version.mjs, etc.
│   └── package.json
├── server/                      # Daemon (Go)
│   ├── cmd/obsidian-remote-server/  # main package
│   ├── internal/
│   │   ├── proto/               # wire types (LSP-style framed JSON-RPC)
│   │   ├── rpc/                 # framing + dispatcher
│   │   ├── handlers/            # fs.* + auth + server.info
│   │   ├── auth/                # token gen + validation
│   │   └── watcher/             # inotify wrapper
│   └── Makefile
├── proto/                       # cross-language wire spec (README.md)
├── docs/                        # Quartz markdown content (this doc set)
├── docs-site/                   # Quartz framework
├── deploy/docker/               # turn-key sshd container
└── .github/workflows/           # CI / release / sync / docs deploys
```

The plugin and server are deliberately separate trees with their own toolchains. They communicate only over the JSON-RPC wire spec in `proto/README.md`.

## Common workflows

### Plugin: build + dev iterate

```bash
cd plugin
npm run dev                     # esbuild in watch mode → main.js
```

Open Obsidian, point a vault at `<your-vault>/.obsidian/plugins/obsidian-remote-ssh-dev` (or symlink the build output there). Reload the plugin in Obsidian after each rebuild — there's no auto-reload.

For the bundled daemon binary the plugin uploads on connect: run `npm run build:server` once. It builds the daemon for your local OS+arch and copies it into `plugin/server-bin/`.

### Plugin: tests

```bash
npm test                        # unit tests, vitest, ~950 tests
npm run test:integration        # SSH integration tests, requires Docker
npm run test:e2e                # Playwright against real Obsidian (slowest)
```

Integration tests assume the test sshd container is up:

```bash
npm run sshd:start              # docker compose up the test sshd
npm run test:integration
npm run sshd:stop               # tear down
```

CI handles this orchestration automatically; locally it's manual.

### Plugin: type check + lint

```bash
node node_modules/typescript/bin/tsc --noEmit  # type check
npm run lint                                    # eslint
```

Both run on every PR; flag them locally before pushing.

### Server: build + test

```bash
cd server
make build                      # native binary → bin/obsidian-remote-server
make cross                      # 4 binaries → dist/obsidian-remote-server-<os>-<arch>
make test                       # go test ./...
```

### Run plugin against your dev daemon

By default the plugin uploads its bundled daemon (the one in `plugin/server-bin/`). To iterate on the daemon, build a fresh `server/bin/obsidian-remote-server` and `cp` it over `plugin/server-bin/obsidian-remote-server-<os>-<arch>`. Reconnect from the plugin — the auto-deploy uploads your fresh binary.

For tighter iteration, run the daemon directly under your test sshd container's user:

```bash
docker compose -f deploy/docker/docker-compose.yml exec -u obsidian sshd \
  /workspace/server/bin/obsidian-remote-server \
  --vault-root=/home/obsidian/vault \
  --socket=/home/obsidian/.obsidian-remote/server.sock \
  --token-file=/home/obsidian/.obsidian-remote/token \
  --verbose
```

The plugin's reuse probe will then attach to your manually-started daemon on connect (skipping the bundled-binary upload).

## Branching + commit conventions

- Feature branches: `feat/<short-name>` → PR into `next`. See `CONTRIBUTING.md` Branching model.
- Stable promotions: `release/X.Y.Z` → PR into `main`. See [[en/contributing/release-flow|Release flow]].
- Commit messages: Conventional Commits (`type(scope): subject`). The full list of allowed types is in `commitlint.config.mjs`. CI rejects PRs whose commits don't conform (sync + promotion PRs are exempted at the workflow level).

## Editor setup hints

- **VSCode**: install ESLint + TypeScript extensions; the `tsconfig.json` in `plugin/` should be auto-detected.
- **GoLand / VSCode Go**: open `server/` as its own root (it has its own `go.mod`).
- **Windows + WSL**: clone inside WSL filesystem (not `/mnt/c/...`), otherwise file-watching for `npm run dev` is unreliable.

## See also

- [[en/contributing/release-flow|Release flow]] — how a change gets from your PR to a published release
- [[en/contributing/testing-strategy|Testing strategy]] — what each test layer is for
- [[en/contributing/documentation|Documentation guide]] — how to add/edit pages on this docs site
- [[en/architecture/release-pipeline|Release & deploy pipeline]] — system view of the CI/CD machinery
- [`CONTRIBUTING.md`](https://github.com/sotashimozono/obsidian-remote-ssh/blob/next/CONTRIBUTING.md) — canonical short-form contributor reference
