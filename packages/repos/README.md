# @kaynooo/cli-repos

`repos` lists the git repositories under a workspace folder (`~/Workspace` by default) that need attention: dirty files, commits not pushed, an upstream ahead of the branch, commits since the latest tag.

```sh
bun add -g @kaynooo/cli-repos
```

| Command | What it does |
| --- | --- |
| `repos [root]` | one row per repository with something to report: branch, dirty files, ahead/behind its upstream, linked worktrees, commits since its latest tag |
| `repos --all` | the clean repositories too |
| `repos --only dirty\|unpushed\|unreleased\|behind` | only the repositories with that reason |
| `repos --fetch` | refreshes each upstream first; it reaches the remote, so it is never done without the flag |
| `repos --pull` | fetches, then fast-forwards the repositories listed that are clean, on a branch and only behind their upstream; each is reported as `pulled` or `skipped` with the reason (dirty, diverged and ahead, no upstream, detached HEAD, fetch failed), and nothing but a fast-forward is ever attempted. A repository pulled is listed again as it now stands. Combine with `--only behind` to touch only those |
| `repos --path` | only the paths of the repositories listed, one per line, for `xargs -d '\n'` (the pull report, if any, goes to stderr) |
| `repos --json` | the same data as JSON |

Exits 0 when it listed the repositories, 1 when a fast-forward `--pull` attempted failed, 2 on a usage error.

A monorepo tagging its packages `<folder>-v<version>` counts the unreleased commits per package folder (`packages/<folder>` or `<folder>`), each since its own latest tag.

Without `--fetch` the ahead and behind counts are those of the last fetch. The walk goes three levels under the root and stops at a `.git`; `node_modules` and hidden folders are skipped. Repositories are skipped by folder name with `~/.config/kaynooo-cli/repos.json` (`$XDG_CONFIG_HOME/kaynooo-cli/` when set; every bin keeps its settings in that folder as `<bin>.json`):

```json
{ "skip": ["archived-thing", "vendored-clone"] }
```
