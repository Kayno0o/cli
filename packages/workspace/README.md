# @kaynooo/cli-workspace

`ws` helps with the repositories under a root: `ws repos` lists the ones needing attention, `ws sweep` reclaims disk, `ws audit` lists known vulnerabilities.

```sh
bun add -g @kaynooo/cli-workspace
```

## ws repos

`ws repos` lists the git repositories under a workspace folder (the configured workspace folder, `~/Workspace` by default) that need attention: dirty files, commits not pushed, an upstream ahead of the branch, commits since the latest tag.

| Command | What it does |
| --- | --- |
| `ws repos [root]` | one row per repository with something to report: branch, dirty files, ahead/behind its upstream, linked worktrees, commits since its latest tag |
| `ws repos --all` | the clean repositories too |
| `ws repos --only dirty\|unpushed\|unreleased\|behind` | only the repositories with that reason |
| `ws repos --fetch` | refreshes each upstream first; it reaches the remote, so it is never done without the flag |
| `ws repos --pull` | fetches, then fast-forwards the repositories listed that are clean, on a branch and only behind their upstream; each is reported as `pulled` or `skipped` with the reason (dirty, diverged and ahead, no upstream, detached HEAD, fetch failed), and nothing but a fast-forward is ever attempted. A repository pulled is listed again as it now stands. Combine with `--only behind` to touch only those |
| `ws repos --path` | only the paths of the repositories listed, one per line, for `xargs -d '\n'` (the pull report, if any, goes to stderr) |
| `ws repos --json` | the same data as JSON |

Exits 0 when it listed the repositories, 1 when a fast-forward `--pull` attempted failed, 2 on a usage error.

A monorepo tagging its packages `<folder>-v<version>` counts the unreleased commits per package folder (`packages/<folder>` or `<folder>`), each since its own latest tag.

Without `--fetch` the ahead and behind counts are those of the last fetch. The walk goes three levels under the root and stops at a `.git`; `node_modules` and hidden folders are skipped. Repositories are skipped by folder name with `~/.config/kaynooo-cli/repos.json` (`$XDG_CONFIG_HOME/kaynooo-cli/` when set; every bin keeps its settings in that folder as `<bin>.json`):

```json
{ "skip": ["archived-thing", "vendored-clone"] }
```

`concurrency` (a positive whole number, 8 by default) in the same file sets how many repositories are read at once. `ws audit` reads the same key from `~/.config/kaynooo-cli/audit.json` (4 by default, the repositories audited at once).

## ws sweep

`ws sweep` reclaims disk across many repos: it lists the regenerable folders and clean git worktrees under a root, largest first, and deletes them only on `--apply`.

| Command | What it does |
| --- | --- |
| `ws sweep [root]` | lists `node_modules`, `.output`, `dist`, `build`, `target` (beside a `Cargo.toml`), the caches (per project `.nuxt`, `.next`, `.turbo`, `.svelte-kit`, `node_modules/.cache`, listed only when `node_modules` is not; global `~/.bun/install/cache`, `~/.npm/_cacache`, `~/.cache/{pip,uv,ms-playwright,puppeteer,go-build,typescript}`, `~/.cargo/registry`, exact paths only, listed only when no root is given or with `--only caches`; a root narrows the scan to its own projects) and `.worktrees/*` and `.claude/worktrees/*` under root (the configured workspace folder, `~/Workspace` by default, three levels down) with size and the age of the repo's last commit; deletes nothing |
| `ws sweep --apply` | deletes what is listed as removable after a confirm showing the total, read from the terminal |
| `--yes` | with `--apply`, skip the confirm; without it, `--apply` refuses off a terminal |
| `--older <duration>`, `--min <size>` | only the entries whose repo last committed longer ago (`30d`) or that weigh at least this much (`500K`, `10M`, `1G`) |
| `--only worktrees\|folders\|caches` | keep one kind and leave the others out; `.nuxt`, `.next`, `.turbo` and `.svelte-kit` are caches, so `folders` does not list them |
| `--json`, `--docker` | machine output, each entry `{path, kind, bytes, committedAt, action, reason}` with `kind` being `folder`, `worktree` or `cache` and `action` `remove` or `keep`; add the `docker system df` output (about ten seconds on its own) |

Safety rules: a symlink is skipped and never followed, a folder git tracks files in is skipped, a build folder git does not ignore is skipped, and nothing outside the listed names is deleted. A folder is deleted for good (not trashed, which would not free the space). A worktree is removed with `git worktree remove`, never forced, and only when it is clean and every commit of its branch is on another branch or a remote; the others stay listed as kept and are left out of the total. With `--docker` the Docker usage is shown, never acted on.

## ws audit

`ws audit` lists the known vulnerabilities of the Bun repositories under a folder (the current one by default), one table per repository.

| Command | What it does |
| --- | --- |
| `ws audit [root]` | one row per package with an advisory: its worst severity, how many advisories, `prod` when a production dependency needs it and `dev` when only a development one does, `direct` when the repository's package.json asks for it and `via` when a dependency does (the `origin` column), and the version that fixes every advisory at once |
| `ws audit --level high` | only the advisories at least that severe: `low`, `moderate` (the default), `high` or `critical` |
| `ws audit --prod` | only the packages a production dependency needs |
| `ws audit --ignore GHSA-xxxx` | skip an advisory by GHSA or numeric id, repeatable, so an accepted advisory stops failing the run |
| `ws audit --json` | `[{repo, path, findings: [{package, severity, scope, direct, fix, advisories: [{id, ghsa, url, title, severity, fixed}]}], error}]` |

It runs `bun audit --json` (and once more with `--prod`, which tells what reaches production) in each folder holding a `bun.lock`, so it reaches the registry. The walk goes three levels deep, stops at a `bun.lock` and skips `node_modules` and hidden folders. The worst rows and the production ones come first; a fix of `-` means an advisory names no fixed version, and a package with ranges for several majors is given the highest fix, which may be a major jump. A repository's workspaces are read as folders or `dir/*`; other globs are not, and their dependencies then show as `via`.

It exits 1 when a repository has an advisory at the level asked, so it can gate a script; it exits 2 when a repository's audit failed, no `bun.lock` sits under the root, on a usage error or a root that is no folder.

`ws audit` sweeps many repositories for advisories only. To vet one repository in depth (package age, install scripts, licences and advisories), use `pkg audit`, which shares `--level`, `--prod` and `--ignore` and nests the same advisory rows in a flat array.
