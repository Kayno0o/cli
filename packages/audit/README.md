# @kaynooo/cli-audit

`audit` lists the known vulnerabilities of the Bun repositories under a folder (the current one by default), one table per repository.

```sh
bun add -g @kaynooo/cli-audit
```

| Command | What it does |
| --- | --- |
| `audit [root]` | one row per package with an advisory: its worst severity, how many advisories, `prod` when a production dependency needs it and `dev` when only a development one does, `direct` when the repository's package.json asks for it and `via` when a dependency does, and the version that fixes every advisory at once |
| `audit --level high` | only the advisories at least that severe: `low`, `moderate` (the default), `high` or `critical` |
| `audit --prod` | only the packages a production dependency needs |
| `audit --json` | the same data as JSON |

It runs `bun audit --json` (and once more with `--prod`, which tells what reaches production) in each folder holding a `bun.lock`, so it reaches the registry. The walk goes three levels deep, stops at a `bun.lock` and skips `node_modules` and hidden folders. The worst rows and the production ones come first; a fix of `-` means an advisory names no fixed version, and a package with ranges for several majors is given the highest fix, which may be a major jump. A repository's workspaces are read as folders or `dir/*`; other globs are not, and their dependencies then show as `via`.

It exits 1 when a repository has an advisory at the level asked or its audit failed, so it can gate a script.
