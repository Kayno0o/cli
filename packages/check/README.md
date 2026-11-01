# check and fix

`check` runs a repo's validation and `fix` its fixers, both showing only what failed, so a Claude Code session spends no tokens on passing output.

```sh
bun install -g @kaynooo/check-tools
check            # run every step found
check --list     # print the steps and the commands that run them
check --only lint,test
check --json     # [{name, command, ok, ms, log, failed?}] once every step ran
```

## Steps

`check`, `typecheck`, `lint` and `test`, run in that order, from the first source that has each one:

| Source | Command |
| --- | --- |
| `package.json` scripts | `bun run <script>` |
| `composer.json` scripts | `composer run <script>` |
| `Justfile` recipes without parameters | `just <recipe>` |
| `Makefile` targets | `make <target>` |

Scripts always go through `bun run`, so a `check` script of `$npm_execpath check` runs Bun's type checker, and a script that calls this bin by name is skipped.

## Output

A passing step is one line: `ok    lint  1.0s  <log path>`. A failing step prints `FAIL`, its command and log path, then only what failed, recognised from the output: `bun test` (failed tests with their own output), `bun check`, tsc, tsgo and vue-tsc (plain and pretty), eslint and keslint (stylish), PHPStan, PHPUnit, ParaTest (a crashed worker included) and Pest. Any other format shows the last 30 lines, and an excerpt is capped at 100 lines. Each step's full output is saved to `<tmp>/check/<repo>-<hash>/<step>.log`, rewritten by the next run, for grep.

Exit code 0 when every step passed, 1 when one failed, 2 on bad usage or when no step is found.

## fix

```sh
fix              # run every fixer that applies to this folder
fix --list       # print them and their commands
fix --only lint:fix,justfile
fix --json       # {fixers, changed}, a skipped fixer as {name, command, skipped}
```

The project's own `fix` script, recipe or target when it has one, else its `lint:fix` (or `lint-fix`) and `format` ones, found in the same sources as `check`'s steps. Then the formatters the folder's files call for:

| Fixer | When | Runs |
| --- | --- | --- |
| `makefile` | a Makefile | declares every target `.PHONY` in one sorted line, collapses blank lines |
| `justfile` | a Justfile | `just --justfile <file> --fmt` |
| `go` | `go.mod` | `go fmt ./... && go mod tidy` |
| `rust` | `Cargo.toml` | `cargo fmt` |
| `python` | `ruff.toml`, `.ruff.toml` or a `[tool.ruff]` section | `ruff check --fix . && ruff format .` |

It looks at the folder itself only, so each package of a monorepo gets its own run. A fixer whose binary is missing is skipped with a `skip` line. Lines and logs read like `check`'s, then the files the run changed are listed, leaving out those already dirty before it, when the folder is in a git repository. A script that calls `fix` again fails instead of recursing.

Exit code 0 when every fixer ran, 1 when one failed, 2 on bad usage or when nothing applies.
