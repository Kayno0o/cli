# agent-tools

CLIs built for Claude Code sessions, each published on its own from `packages/`.

| Package | Bin | What it does |
| --- | --- | --- |
| [`@kaynooo/forgejo-tools`](packages/ft) | `ft` | Forgejo CI runs and failures, releases, issue checklists and issue claims between sessions, through tea |

## Development

```sh
bun install
bun run check && bun run lint && bun run test
```
