# agent-tools

CLIs built for Claude Code sessions, each published on its own from `packages/`.

| Package | Bin | What it does |
| --- | --- | --- |
| [`@kaynooo/forgejo-tools`](packages/ft) | `ft` | Forgejo CI runs and failures, releases, issue checklists and issue claims between sessions, through tea |
| [`@kaynooo/env-tools`](packages/env) | `ev`, `redact` | .env files listed and edited with secrets masked; secrets masked in any piped output |
| [`@kaynooo/db-tools`](packages/db) | `db` | read-only SQL against Postgres that never shows the connection credentials, writes handed back as SQL |
| [`@kaynooo/check-tools`](packages/check) | `check` | a repo's check, typecheck, lint and test steps, showing only what failed |
| [`@kaynooo/pkg-tools`](packages/pkg) | `pkg` | an npm package checked before it is added: guessed names, versions under two weeks old, install scripts |
| [`@kaynooo/out-tools`](packages/out) | `out` | noisy command output folded, errors kept, the full log saved to a file |
| [`@kaynooo/cli-kit`](packages/kit) | - | argument parsing with `--help`, the command dispatcher and output formatting every CLI here shares |

## Development

```sh
bun install
bun run check && bun run lint && bun run test
```

## Releasing

Each package releases on its own: `just release <folder> <patch|minor|major>` bumps `packages/<folder>`, tags it `<folder>-v<version>`, and the tag's workflow publishes that folder. A package depending on a newer `@kaynooo/cli-kit` than the registry serves needs kit released first.

## Claude Code mod

The `agent-tools` mod (in the user's dotfiles, `zshrc/dotfiles/claude/mods/agent-tools`) wires these in: it refuses Read, Edit, Write and Bash calls on `.env` files with a pointer to `ev` and `redact`, and runs noisy builds, installs, tests and linters through `out` once it is installed.
