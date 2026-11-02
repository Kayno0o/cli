# check and fix

`check` runs a repo's validation and `fix` its fixers, both showing only what failed, so a Claude Code session spends no tokens on passing output.

```sh
bun install -g @kaynooo/check-tools
check            # run every step found
check --list     # print the steps and the commands that run them
check --only lint,test
check --timeout 5m   # end a step still running after 5 minutes, exit 2
check --slot     # queue each step behind the machine-wide slots of `slot` (@kaynooo/wait-tools)
check --json     # [{name, command, ok, ms, log, failed?}] once every step ran
```

## Steps

`check`, `typecheck`, `lint` and `test`, run in that order, from the first source that has each one:

| Source | Command |
| --- | --- |
| `package.json` scripts | `bun run <script>` |
| `composer.json` scripts | `composer run <script>` |
| `Justfile` recipes that need no argument (read from `just --dump --dump-format json`, private ones left out) | `just <recipe>` |
| `GNUmakefile`, `makefile` or `Makefile` targets, in the order make reads them | `make <target>` |

Scripts always go through `bun run`, so a `check` script of `$npm_execpath check` runs Bun's type checker, and a script that calls this bin by name is skipped.

## Output

A passing step is one line: `ok    lint  1.0s  <log path>`. A failing step prints `FAIL`, its command and log path, then only what failed, recognised from the output: `bun test` (failed tests with their own output), `bun check`, tsc, tsgo and vue-tsc (plain and pretty), eslint and keslint (stylish), PHPStan, PHPUnit, ParaTest (a crashed worker included) and Pest. Any other format shows the last 30 lines, and an excerpt is capped at 100 lines. Each step's full output is saved to `<run folder>/<step>.log`, for grep: one folder per run under `$XDG_RUNTIME_DIR/agent-tools/check` (`~/.cache/agent-tools/check` without it), only the user can enter it, files are mode 0600, and runs older than three days are removed. `--only` naming no step fails instead of passing silently.

SIGINT, SIGTERM and SIGHUP go to the running step's whole process group and `check` stops there. `--timeout` (`-t`, `30s`, `5m`) ends a step and everything it started.

Exit code 0 when every step passed, 1 when one failed, 2 on bad usage, when no step is found or when a step timed out.

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
| `makefile` | a Makefile | declares every command target `.PHONY` in one sorted line (a continued `.PHONY` line replaced whole, targets that are files or depend on files left out), collapses blank lines, writes only when the content changes |
| `justfile` | a Justfile | `just --justfile <file> --fmt` |
| `go` | `go.mod` | `go fmt ./... && go mod tidy` |
| `rust` | `Cargo.toml` | `cargo fmt` |
| `python` | `ruff.toml`, `.ruff.toml` or a `[tool.ruff]` section | `ruff check --fix . && ruff format .` |

It looks at the folder itself only, so each package of a monorepo gets its own run. A fixer whose binary is missing is skipped with a `skip` line. Lines and logs read like `check`'s, then the files the run changed are listed, leaving out those already dirty before it, when the folder is in a git repository. A script that calls `fix` again fails instead of recursing.

Exit code 0 when every fixer ran, 1 when one failed, 2 on bad usage or when nothing applies.

## errs

```sh
errs build.log                  # a log file, or - for stdin
tsgo -p . 2>&1 | errs
errs -- bun test                # run a command, parse its output
errs --json -- keslint src      # {errors, unrecognised, log?, code?}
```

Turns tsc, tsgo and vue-tsc (plain and pretty), bun check, eslint and keslint (stylish) and bun test logs into one `file:line:col: message (rule)` line per error, so a session reads the failures without the log. A failed bun test reads `file:line:col: <test name>: <assertion> (expected X, received Y)`, located at the first stack frame of its error, and an eslint warning is prefixed `warning:`. Absolute paths under the current folder are printed relative.

`--json` prints `{errors: [{tool, file, line, column, rule?, severity, message, test?}], unrecognised, log?, code?}`. Lines no format recognised are never dropped silently: their count goes to stderr, with the path of the full log. A command run after `--` has its whole output saved with the same log writer as `out`, and `log` is that file (the file given when a log is read, nothing for stdin). A first argument that is neither an option nor an existing file starts the command, so the `--` is optional.

Exit code 0 when no error was found and the command, if any, passed, 1 when errors were found or the command failed, 2 on bad usage.
