# check

Runs a repo's validation and shows only what failed, so a Claude Code session spends no tokens on passing output.

```sh
bun install -g @kaynooo/check-tools
check            # run every step found
check --list     # print the steps and the commands that run them
check --only lint,test
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

A passing step is one line: `ok    lint  1.0s  <log path>`. A failing step prints `FAIL`, its command and log path, then only what failed, recognised from the output: `bun test` (failed tests with their own output), `bun check`, tsc, tsgo and vue-tsc (plain and pretty), eslint and keslint (stylish), PHPStan, PHPUnit and Pest. Any other format shows the last 30 lines, and an excerpt is capped at 100 lines. Each step's full output is saved to `<tmp>/check/<repo>-<hash>/<step>.log`, rewritten by the next run, for grep.

Exit code 0 when every step passed, 1 when one failed, 2 on bad usage or when no step is found.
