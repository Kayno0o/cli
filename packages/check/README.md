# check and fix

`check` runs a repo's validation and `fix` its fixers, both showing only what failed, so a Claude Code session spends no tokens on passing output.

```sh
bun install -g @kaynooo/cli-check
check            # run every step found
check --list     # print the steps and the commands that run them
check --only lint,test
check --timeout 5m   # end a step still running after 5 minutes, exit 2
check --slot     # queue each step behind the machine-wide slots of `slot` (@kaynooo/cli-wait)
check --in app   # run every step in this compose service, whatever is detected
check --host     # run on the host even when a compose service mounts the folder
check --json     # [{name, command, in?, ok, ms, log, failed?}] once every step ran
```

## Steps

`check`, `typecheck`, `lint` and `test`, run in that order, from the first source that has each one:

| Source | Command |
| --- | --- |
| `package.json` scripts | `bun run <script>` |
| `composer.json` scripts | `composer run <script>` |
| `Justfile` recipes that need no argument (read from `just --dump --dump-format json`, private ones left out) | `just <recipe>` |
| `GNUmakefile`, `makefile` or `Makefile` targets, in the order make reads them | `make <target>` |
| `phpstan.neon`, `phpstan.neon.dist` or `phpstan.dist.neon`, when no source above has a `typecheck` | `vendor/bin/phpstan analyse --no-progress --memory-limit=1G` |
| `.php-cs-fixer.php` or `.php-cs-fixer.dist.php`, when no source above has a `lint` | `vendor/bin/php-cs-fixer fix --dry-run -v` (the fixers each file needs are named) |
| `phpunit.xml`, `phpunit.xml.dist` or `phpunit.dist.xml`, when no source above has a `test` | `vendor/bin/phpunit` |

Scripts always go through `bun run`, so a `check` script of `$npm_execpath check` runs Bun's type checker, and a script that calls this bin by name is skipped.

A folder with no step of its own but subfolders that have some (a root with `api/` and `client/`) runs each subfolder's steps, in alphabetical order, each line naming it: `api/lint`, `client/test`. `--only lint` picks `lint` in every one, and each step runs in its own subfolder. Only the folder's direct children are looked at, without hidden ones, `node_modules`, `vendor`, `dist`, `build`, `var`, `tmp` and `coverage`.

## In the compose service

Acme repos run their tools in a container, so `check`, `fix` and `errs -- <command>` run a step inside the docker compose service that bind-mounts its folder, instead of on the host. The project is the nearest `compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` from the step's folder up to the repository root (the folder holding `.git`), with its `compose.override.*` merged in. A service qualifies when one of its bind mounts (`.:/app`, `./api:/var/www/html`, the long `type: bind` syntax, `${VAR:-default}` interpolated with the environment and the project's `.env`) holds the folder, a mount of a parent folder included; named volumes are ignored. The step runs `docker compose exec -T -w <path of the folder in the container> <service> sh -c '<command>'` from the project's folder, with `NO_COLOR=1 FORCE_COLOR=0` set, and the container path is the mount's target plus the folder's path under its source.

- The stack is only read: `docker compose ps --services --status running` is asked once per project, and a service that is down is never started. The step fails, naming the service and where its project lives, and the other steps go on; start the stack yourself, or pass `--host`.
- Several services mounting the folder (php and a worker): the one whose name, image or build names the step's tool wins (`bun` and `node` look for `bun` or `node`, `composer`, `php`, `phpunit`, `phpstan` and `vendor/bin/*` for `php`). When none or several stand out the call fails listing them and asks for `--in <service>`.
- `--in <service>` runs in that service, failing when it does not exist or does not mount the folder. `--host` runs on the host. Both together are a usage error.
- `check --list` has a column saying where each step runs, `host` or the service; `--json` adds `in` with the service name to a step that runs in one (`--list --json` as well).
- `COMPOSE_FILE` (in the environment or the project's `.env`) replaces the search for `compose.yaml`: the files it names, separated by `:` (`COMPOSE_PATH_SEPARATOR` if set) and read relative to the project folder, are merged in order. A file it names that does not exist fails the call, as `docker compose` would.
- No `docker` on the PATH (a devcontainer, CI): there is no container to reach, so the step runs on the host and stderr says `host, docker not found` once per project; `--in <service>` fails instead.
- A compose file that does not parse fails the call naming the file and the parse error, and points at `--host`; it never falls back to the host silently, even without docker.
- `--slot` queues the whole docker command. `--timeout` ends the `docker compose exec` client, which does not always end what it started inside the container.
- `fix` runs the project's scripts and `php-cs-fixer` in the service, and keeps its own formatters (`justfile`, `go`, `rust`, `python`, `makefile`) on the host. The recursion guard variable is passed into the container.

## Output

A passing step is one line: `ok    lint  1.0s  <log path>`. A failing step prints `FAIL`, its command and log path, then only what failed, recognised from the output: `bun test` (failed tests with their own output), `bun check`, tsc, tsgo and vue-tsc (plain and pretty), eslint and keslint (stylish), Vitest, Playwright, PHP CS Fixer (its dry-run listing without the diffs), PHPStan, PHPUnit, ParaTest (a crashed worker included) and Pest. Any other format shows the last 30 lines, and an excerpt is capped at 100 lines. Each step's full output is saved to `<run folder>/<step>.log`, for grep: one folder per run under `$XDG_RUNTIME_DIR/kaynooo-cli/check` (`~/.cache/kaynooo-cli/check` without it), only the user can enter it, files are mode 0600, and runs older than three days are removed. `--only` naming no step fails instead of passing silently.

SIGINT, SIGTERM and SIGHUP go to the running step's whole process group and `check` stops there. `--timeout` (`-t`, `30s`, `5m`) ends a step and everything it started.

Exit code 0 when every step passed, 1 when one failed, 2 on bad usage, when no step is found or when a step timed out.

## fix

```sh
fix              # run every fixer that applies to this folder
fix --list       # print them and their commands
fix --only lint:fix,justfile
fix --in app     # run the scripts in this compose service; --host forces the host
fix --json       # {fixers, changed}, a skipped fixer as {name, command, skipped}
```

The project's own `fix` script, recipe or target when it has one, else its `lint:fix` (or `lint-fix`) and `format` ones, found in the same sources as `check`'s steps. Then the formatters the folder's files call for:

| Fixer | When | Runs |
| --- | --- | --- |
| `php-cs-fixer` | `.php-cs-fixer.php` or `.php-cs-fixer.dist.php`, and no fixer script in `composer.json` | `vendor/bin/php-cs-fixer fix` |
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
errs --in app -- vendor/bin/phpunit   # in this compose service; --host forces the host
```

Turns tsc, tsgo and vue-tsc (plain and pretty), bun check, eslint and keslint (stylish), bun test, vitest, playwright, phpunit, paratest, phpstan, php-cs-fixer, go (build and vet), cargo (rustc), ruff (concise and full) and pytest logs into one `file:line:col: message (rule)` line per error, so a session reads the failures without the log. A failed bun test reads `file:line:col: <test name>: <assertion> (expected X, received Y)`, located at the first stack frame of its error, and an eslint warning is prefixed `warning:`. Absolute paths under the current folder are printed relative.

| Tool | Read from | One error per |
| --- | --- | --- |
| `phpunit`, `paratest` (9 to 12, colours or not) | the "There was 1 error" and "There were 3 failures" listings | failed or errored test: `file:line: Class::test: message`, at the first file under its trace, an assertion diff cut to its changed lines. Risky tests, warnings, deprecations and notices are never counted |
| `phpstan` | the default table, `--error-format=raw` and `json` | message: `file:line: message (identifier)`, a wrapped table message joined, problems with no file at line 0 |
| `php-cs-fixer` | `fix --dry-run` (`-v` names the fixers, `--diff` is skipped) | file: `file:0:0: style issues to fix (fixer, fixer)` |
| `playwright` | the list and line reporters | failed test: the spec file and line of the first stack frame, the first error line and `expected X, received Y`. A test that passed on retry is flaky and not reported |
| `vitest` | the default and verbose reporters | failed test, or suite that failed to load, at its first `file:line:col` frame |

`--json` prints `{errors: [{tool, file, line, column, rule?, severity, message, test?}], unrecognised, log?, code?}`, `tool` one of `tsc`, `eslint`, `bun check`, `bun test`, `vitest`, `playwright`, `phpunit`, `phpstan`, `php-cs-fixer`, `go`, `cargo`, `ruff` or `pytest`. Lines no format recognised are never dropped silently: their count goes to stderr, with the path of the full log. A command run after `--` has its whole output saved with the same log writer as `out`, and `log` is that file (the file given when a log is read, nothing for stdin). A first argument that is neither an option nor an existing file starts the command, so the `--` is optional. A command runs in the compose service mounting the current folder like a `check` step does (see above), `--in` and `--host` applying only to a command; a service that is down exits 1 with the service named.

Exit code 0 when no error was found and the command, if any, passed, 1 when errors were found or the command failed, 2 on bad usage.
