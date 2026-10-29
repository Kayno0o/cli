# agent-tools

CLIs built for Claude Code sessions, each published on its own from `packages/`.

| Package | Bin | What it does |
| --- | --- | --- |
| [`@kaynooo/forgejo-tools`](packages/ft) | `ft` | Forgejo CI runs and failures, releases, issue checklists and issue claims between sessions, through tea |
| [`@kaynooo/cli-kit`](packages/kit) | - | argument parsing with `--help`, the command dispatcher and output formatting every CLI here shares |

## Development

```sh
bun install
bun run check && bun run lint && bun run test
```

## Releasing

Each package releases on its own: `just release <folder> <patch|minor|major>` bumps `packages/<folder>`, tags it `<folder>-v<version>`, and the tag's workflow publishes that folder. A package depending on a newer `@kaynooo/cli-kit` than the registry serves needs kit released first.
