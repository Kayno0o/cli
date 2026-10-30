# agent-tools

CLIs built for Claude Code sessions, each published on its own from `packages/`.

| Package | Bin | What it does |
| --- | --- | --- |
| [`@kaynooo/forgejo-tools`](packages/ft) | `ft` | Forgejo CI runs and failures, releases, issue checklists and issue claims between sessions, through tea |
| [`@kaynooo/env-tools`](packages/env) | `ev`, `redact` | .env files listed and edited with secrets masked; secrets masked in any piped output |
| [`@kaynooo/db-tools`](packages/db) | `db` | read-only SQL against Postgres that never shows the connection credentials, writes handed back as SQL |
| [`@kaynooo/check-tools`](packages/check) | `check`, `fix` | a repo's check, typecheck, lint and test steps, or its fixers and formatters, showing only what failed |
| [`@kaynooo/pkg-tools`](packages/pkg) | `pkg` | an npm package checked before it is added: guessed names, versions under two weeks old, install scripts |
| [`@kaynooo/stack-tools`](packages/stack) | `stack` | a stable port per service name, and a compose release setup audited against its `release.config.ts` |
| [`@kaynooo/out-tools`](packages/out) | `out` | noisy command output folded, errors kept, the full log saved to a file |
| [`@kaynooo/edit-tools`](packages/edit) | `sub` | text replaced in files, written only when every replacement matches as often as expected |
| [`@kaynooo/gitlab-tools`](packages/gitlab) | `gl` | GitLab pipelines waited on, listed and read, each failed job's trace cut to its failed tests, through glab |
| `packages/kit` (private) | - | argument parsing with `--help`, the command dispatcher, input, process and formatting helpers every CLI here shares, bundled into each |

## Development

```sh
bun install
bun run check && bun run lint && bun run test
```

## Releasing

Each CLI releases on its own: `just release <folder> <patch|minor|major>` bumps `packages/<folder>`, tags it `<folder>-v<version>`, and the tag's workflow builds that folder (`bun run build`, a Bun bundle per bin with `packages/kit` inlined) and publishes it. Kit is never published: a kit change reaches a CLI with that CLI's next release.

## Claude Code mod

The `agent-tools` mod (in the user's dotfiles, `zshrc/dotfiles/claude/mods/agent-tools`) wires these in: it refuses Read, Edit, Write and Bash calls on `.env` files with a pointer to `ev` and `redact`, and runs noisy builds, installs, tests and linters through `out` once it is installed.
