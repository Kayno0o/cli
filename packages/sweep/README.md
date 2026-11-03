# @kaynooo/cli-sweep

`sweep` reclaims disk across many repos: it lists the regenerable folders and clean git worktrees under a root, largest first, and deletes them only on `--apply`.

```sh
bun add -g @kaynooo/cli-sweep
```

| Command | What it does |
| --- | --- |
| `sweep [root]` | lists `node_modules`, `.nuxt`, `.next`, `.output`, `dist`, `build`, `.turbo`, `.svelte-kit`, `target` (beside a `Cargo.toml`) and `.worktrees/*` and `.claude/worktrees/*` under root (`~/Workspace` by default, three levels down) with size and the age of the repo's last commit; deletes nothing |
| `sweep --apply` | deletes what is listed as removable after a confirm showing the total, read from the terminal |
| `--yes` | with `--apply`, skip the confirm; without it, `--apply` refuses off a terminal |
| `--older <duration>`, `--min <size>` | only the entries whose repo last committed longer ago (`30d`) or that weigh at least this much (`500K`, `10M`, `1G`) |
| `--json`, `--docker` | machine output; add the `docker system df` output (about ten seconds on its own) |

Safety rules: a symlink is skipped and never followed, a folder git tracks files in is skipped, a build folder git does not ignore is skipped, and nothing outside the listed names is deleted. A folder is deleted for good (not trashed, which would not free the space). A worktree is removed with `git worktree remove`, never forced, and only when it is clean and every commit of its branch is on another branch or a remote; the others stay listed as kept and are left out of the total. With `--docker` the Docker usage is shown, never acted on.
