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
| `repos --json` | the same data as JSON |

A monorepo tagging its packages `<folder>-v<version>` counts the unreleased commits per package folder (`packages/<folder>` or `<folder>`), each since its own latest tag.

Without `--fetch` the ahead and behind counts are those of the last fetch. The walk goes three levels under the root and stops at a `.git`; `node_modules` and hidden folders are skipped. Repositories are skipped by folder name with `~/.config/kaynooo-cli/repos.json`:

```json
{ "skip": ["archived-thing", "vendored-clone"] }
```
