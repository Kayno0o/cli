# @kaynooo/cli-icons

`icons` finds the icons of a project's iconify sets, so an agent building a page imports a name that exists instead of guessing one. Beyond the names holding the words, it finds the icons a related word names (`garbage` finds `trash`, `dark mode` finds `moon`), a typo (`calnedar`) or a half-typed word (`shopp`).

```sh
bun add -g @kaynooo/cli-icons
```

| Command | What it does |
| --- | --- |
| `icons garbage` | every `@iconify-json/*` set in the nearest `node_modules`, up to 10 icons per set, as `<set>:<name>`, best first |
| `icons --set tabler dark mode` | only the set with that prefix |
| `icons --limit 30 arrow` | more icons per set |
| `icons --json calnedar` | `[{set, name}]` |

The search is `@kayjs/icons/search` bundled in: a word table built offline from Tabler's and Lucide's tags and a local `bge-small-en-v1.5` run, so it reads no network and runs no model. English only.

In a kay app with the icons plugin registered, `bunx kay icons-find <words>` prints the same icons as `~icons/<set>/<name>` imports.
