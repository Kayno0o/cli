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

`pkg` exits 1 when a package is missing, the request matches no version, or the resolved version is too fresh; other warnings exit 0. `--json` prints one report, or an array for several names, `--min-age <days>` changes the 14 days.

## Moving consumers onto a release

```sh
pkg consumers @kaynooo/cli-kit
pkg bump @kaynooo/cli-kit 0.8.0 --dry-run
```

- `pkg consumers <name>` lists every `package.json` under `--root` (`~/Workspace`) depending on the package, `node_modules`, `dist` and dot folders left out: the folder, the kind of dependency, the version it asks for and the manager its nearest lockfile pins; `--json` for the rows.
- `pkg bump <name> [version]` waits until the package's registry serves the version (every 5 s, `-t 10m`; the latest when none is given), then runs `bun add --exact --no-cache <name>@<version>` in each of those folders, one after another, as the same kind of dependency (`--dev`, `--optional`, `--peer`), a line per folder. A `workspace:`, `link:` or `file:` dependency, a folder already on the version and one whose lockfile pins another manager are left alone and said so; `--dry-run` prints what would run. It exits 1 when an install fails or the version never shows.
- `pkg <name>` alone still runs `pkg check`.

## Registries

The metadata comes from the registry the name is installed from. A `@scope/` name follows `@scope:registry=` in the nearest `.npmrc` or `[install.scopes]` in the nearest `bunfig.toml`, walking up from the current directory and ending at the home directory; the token (`_authToken`, or `token` in bunfig, with `${VAR}` or `$VAR` expanded) is sent to that registry only and never printed. Downloads come from the npmjs.org API, so they show `-` for any other registry. A registry that does not return publish times (Forgejo's does not) leaves the age unchecked, which `pkg` says in a warning.

## Maintenance

- `bun run popular` regenerates `src/popular.json`, the 500 most downloaded names from the [npm-high-impact](https://www.npmjs.com/package/npm-high-impact) list.
- `bun run record` re-records the trimmed registry responses in `tests/fixtures`; the tests never touch the network.
