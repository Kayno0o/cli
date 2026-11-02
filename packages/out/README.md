# out

Shortens noisy command output for Claude Code: installs, builds, test runners and linters print hundreds of lines a session mostly does not need, and `out` folds them while keeping what matters.

```sh
bun install -g @kaynooo/out-tools
out -- bun install
bun run build 2>&1 | out
```

## Behaviour

- Output of at most 150 lines (`-n <lines>` changes it) passes through byte for byte, stdout and stderr to their own streams.
- Longer output is captured (both streams, in arrival order) and printed folded, after a header with the line count, how many lines were left out and the path of the full log.
- Lines alike in shape (ANSI codes stripped; numbers, hashes, durations, percentages, paths and file names normalized) fold into one line with a count and the last line: `[1/300] compiling a.ts (x300, last: [300/300] compiling z.ts)`.
- A block of 2 to 20 lines repeated back to back is shown once, followed by `(block repeated N times)`.
- A line or block seen earlier is replaced by `(same as line N)`, N being a line of the full log, and the header lists the most repeated messages with their counts.
- Carriage-return progress (spinners, bars) keeps only the final state of each line.
- The head and tail are kept, and lines with `error`, `fail`, `warn`, `panic`, `exception`, `fatal` or a stack frame stay even in the folded middle.
- The exit code is always the wrapped command's. Piped into with no command, `out` folds what it reads and exits 0, the writer's code left to `set -o pipefail`; only stdout is piped, so `2>&1` brings stderr along. A terminal or `/dev/null` on stdin with no command is a usage error.
- The output is streamed to a full log as it arrives once it outgrows the 4 MiB held in memory (the first and last 2 MiB), otherwise the log is written when folding. Logs go to `$XDG_RUNTIME_DIR/agent-tools/out` (`~/.cache/agent-tools/out` without it), a folder only the user can enter, files at mode 0600, and logs older than a day are removed on the next run.
- SIGINT, SIGTERM and SIGHUP go to the command's whole process group, and `out` exits with its code. A watch command (`--watch`, `tsc -w`, `just dev`) is never wrapped by the hook, as its output would sit buffered.

## Wrapping from a hook

The pure functions a Claude Code PreToolUse hook needs live in `src/wrap.ts`: `shouldWrap(command)` is true when every part of a command line is a listed noisy command (installs, builds, test runners, linters, `docker build`/`docker compose build|pull`, `just <recipe>`), with no pipe, redirect, background, substitution, `--json` or `--help`. A runner is known by its last path segment (`vendor/bin/phpunit`), through `php` (`php bin/phpunit`) and inside `docker compose exec|run` or `docker exec` (`docker compose exec -T php vendor/bin/paratest`). A line ending in pipes into `tail`, `head` or `grep` only (not `grep -c`, `-q`, `-l` or `-L`) is wrapped with those stages and the `2>&1` feeding them dropped, since the folded output already keeps the failures they would have picked out. `wrap(command)` returns `out -- <command>`, through `sh -c '...'` for `&&` chains and leading `VAR=value` assignments. The agent-tools mod in the user's dotfiles carries a copy, as a mod cannot import a package.
