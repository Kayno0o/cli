# pkg

Checks an npm package before it is added: a guessed or typosquatted name, a version published less than two weeks ago, and install scripts.

```sh
bun install -g @kaynooo/pkg-tools
pkg esbuild
pkg left-pad@1.3.0 @types/node --json
```

## What it prints

- Whether the name exists, the version the request resolves to (an exact version, a dist-tag or a range), the latest version, and the highest stable version at least two weeks old (`safe`), each with its publish date.
- Weekly downloads (public registry only), licence and repository.
- Warnings for a version under the minimum age (with the `safe` version to use instead), `preinstall`, `install` and `postinstall` scripts, a deprecated version, and a name that is a near miss of a popular package (one or two edits, other separators or case, or the same name under another scope).

`pkg` exits 1 when a package is blocked (missing, the request matches no version or is not a valid range, the resolved version is too fresh or has no publish date on npmjs.org, its licence is outside the allowlist, or an advisory reaches the threshold), 2 when it could not check (the registry unreachable, slower than 10 s or answering badly, a broken `.pkgrc.json`, `bunfig.toml` or `.npmrc`) or on a usage error; other warnings exit 0. `--json` prints one report, or an array for several names, `--min-age <days>` changes the 14 days.

## Config: licence allowlist and advisory threshold

`pkg` reads its own settings from a `.pkgrc.json` in the current folder or any folder above it, then from `~/.config/pkg/config.json`; each key comes from the nearest file that sets it, and comments are allowed.

```json
{ "licenses": ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause"], "blockSeverity": "high" }
```

- `licenses` is the allowlist of SPDX ids, compared without regard to case. An expression is allowed when one side of an `OR` is and every term of an `AND` is; a `WITH` exception is ignored. With an allowlist set, `pkg check` refuses a package whose licence is outside it or missing (a legacy `SEE LICENSE IN` or `UNLICENSED` counts as outside), so the `bun add` the guard checks through `pkg check` is refused with it. Without the key the licence is only printed.
- `blockSeverity` (`low`, `moderate`, `high` or `critical`, `high` when no config sets it) makes `pkg check` ask the registry for the advisories of the exact `name@version` and refuse it when one is at that severity or above. The request is the one `bun audit` makes: a `POST` of `{"name": ["version"]}` to `<registry>/-/npm/v1/security/advisories/bulk`. A registry without that endpoint (a private one, say) leaves the version unrefused with a warning, while an advisory request that fails (unreachable, a 5xx, not JSON) exits 2, since the advisories could not be read.

## Auditing a lockfile

```sh
pkg audit
pkg audit ~/Workspace/app --audit-level high --ignore GHSA-238p-pmpm-9mq7 --json
```

`pkg audit [dir]` reads the `bun.lock` of the folder and runs the checks of `pkg check` on every registry package it pins (workspace, git and link sources left out): the age of the version, install scripts, a deprecated version, a near miss of a popular name and the licence allowlist. It also lists the known advisories of every pinned version, each with its GHSA, severity and the version that fixes it when the range ends at one. Findings come grouped per package, each package looked up on the registry once per run, and all advisories fetched in one request per registry.

- `--audit-level <low|moderate|high|critical>` (`low`) keeps only the advisories at that severity or above, and `--ignore <GHSA or id>` (repeatable) skips an advisory; `blockSeverity` is for `pkg check` and does not apply here.
- `--json` prints the packages with a finding as `[{name, version, license, blocked, warnings, advisories}]`; `--min-age <days>` changes the 14 days.
- It exits 1 when a package is missing, too fresh or outside the allowlist, or an advisory remains after the level and the ignores; install scripts and near misses alone exit 0. When the advisories of a registry could not be read it warns which, never prints a clean result for them, and exits 2 unless something already blocks.
- An `npm:` alias (`"lodash": "npm:other@1.0.0"`) is audited as the package it names.

## Moving consumers onto a release

```sh
pkg consumers @kaynooo/cli-kit
pkg bump @kaynooo/cli-kit 0.8.0 --dry-run
```

- `pkg consumers <name>` lists every `package.json` under `--root` (`~/Workspace`) depending on the package, `node_modules`, `dist`, `build`, `vendor`, `target`, `coverage` and dot folders left out and nothing deeper than 5 levels below `--root` (point `--root` at the folder to reach further): the folder, the kind of dependency, the version it asks for and the manager its nearest lockfile pins; `--json` for the rows.
- `pkg bump <name> [version]` waits until the package's registry serves the version (every 5 s, `-t 10m`; the latest when none is given, an exact version otherwise, never a range or a tag), then vets it with the checks of `pkg check` (advisories, licence allowlist) before any folder is touched, and runs `bun add --exact --no-cache <name>@<version>` in each of those folders, one after another, as the same kind of dependency (`--dev`, `--optional`), a line per folder. A version the vetting blocks is refused with its reasons and exit 1; `--force` bumps it anyway. A bump adopts a release on purpose, often one just made, so it checks no minimum age unless `--min-age <days>` asks for one. A dependency that is not a registry version (`workspace:`, `link:`, `file:`, `git`, a URL, an `npm:` alias, `catalog:`), a `peerDependencies` range, a folder already on the version and one whose lockfile pins another manager are left alone and said so; `--dry-run` prints what would run. A transient registry error is retried until the timeout. It exits 1 when the vetting refuses the version, an install fails or the registry has no such package (at once, without waiting), 2 when the version never shows within the timeout.
- `pkg bump <name> [version] --all-consumers` leaves alone a folder whose `package.json` or lockfile already has uncommitted changes, so that `gc` never commits them as the bump, and goes on in each folder whose install went through: it runs the folder's own `check` and, only when that passes, commits with `gc 'chore(deps): bump <name> to <version>' -- package.json <lockfile>` (the `bun.lock` or `bun.lockb` nearest the folder, a monorepo's at its root). A folder whose check fails stays uncommitted. It ends on a summary line of the folders bumped and committed, bumped and failing, and skipped, exits 1 when an install, a check or a commit failed, and never pushes. With `--dry-run` it lists the `bun add`, `check` and `gc` each folder would run.
- `pkg <name>` alone still runs `pkg check`.

## Registries

The metadata comes from the registry the name is installed from. A `@scope/` name follows `@scope:registry=` in the nearest `.npmrc` or `[install.scopes]` in the nearest `bunfig.toml`, walking up from the current directory and ending at the home directory, and a scope key wins over a nearer plain `registry=`, as it does for npm; the token (`_authToken`, or `token` in bunfig, with `${VAR}` or `$VAR` expanded) is sent to that registry only, matched on a path boundary, over https (or http to localhost) only, and never printed. Environment variables are expanded in tokens only, never in a registry address. Every request has a 10 s deadline. Downloads come from the npmjs.org API, so they show `-` for any other registry. A registry that does not return publish times (Forgejo's does not) leaves the age unchecked, which `pkg` says in a warning.

## Maintenance

- `bun run popular` regenerates `src/popular.json`, the 500 most downloaded names from the [npm-high-impact](https://www.npmjs.com/package/npm-high-impact) list.
- `bun run record` re-records the trimmed registry responses in `tests/fixtures`; the tests never touch the network.
