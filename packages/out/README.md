# out

Shortens noisy command output for Claude Code: installs, builds, test runners and linters print hundreds of lines a session mostly does not need, and `out` folds them while keeping what matters.

```sh
bun install -g @kaynooo/cli-out
out -- bun install
bun run build 2>&1 | out
out --stats --since 7d
```

## Behaviour

- Output of at most 150 lines (`-n <lines>` changes it) and about 8 KB (55 bytes per allowed line) passes through byte for byte, stdout and stderr to their own streams.
- Longer output is captured (both streams, in arrival order) and printed folded, after a header with the line count, how many lines were left out and the path of the full log.
- Lines alike in shape (ANSI codes stripped; numbers, hashes, durations, percentages, paths and file names normalized) fold into one line with a count and the last line: `[1/300] compiling a.ts (x300, last: [300/300] compiling z.ts)`.
- A block of 2 to 20 lines repeated back to back is shown once, followed by `(block repeated N times)`.
- A line or block seen earlier is replaced by `(same as line N)`, N being a line of the full log, and the header lists the most repeated messages with their counts.
- Carriage-return progress (spinners, bars) keeps only the final state of each line.
- The head and tail are kept, and lines with `error`, `fail`, `warn`, `panic`, `exception`, `fatal` or a stack frame stay even in the folded middle, the first 40 of them. Lines wider than 300 characters are cut in the folded output (the full log keeps them), and a few-lines output that is still heavy keeps a shorter head and tail.
- The exit code is always the wrapped command's. Piped into with no command, `out` folds what it reads and exits 0, the writer's code left to `set -o pipefail`; only stdout is piped, so `2>&1` brings stderr along. A terminal or `/dev/null` on stdin with no command is a usage error.
- The output is streamed to a full log as it arrives once it outgrows the 4 MiB held in memory (the first and last 2 MiB), otherwise the log is written when folding. Logs go to `$XDG_RUNTIME_DIR/kaynooo-cli/out` (`~/.cache/kaynooo-cli/out` without it), a folder only the user can enter, files at mode 0600, and logs older than a day are removed on the next run.
- SIGINT, SIGTERM and SIGHUP go to the command's whole process group, and `out` exits with its code. A watch command (`--watch`, `tsc -w`, `just dev`) is never wrapped by `guard`, as its output would sit buffered.

## Stats

- Each run appends a line to `$XDG_STATE_HOME/kaynooo-cli/out/stats.jsonl` (`~/.local/state/...` without it, folder 0700, file 0600): the time, the folder, the words naming the command, the bytes it printed, the bytes the session would have read without `out` and the bytes `out` showed. Only lowercase words without digits after the program are kept (`bun run build`, `docker compose exec`), so no argument, assignment or token reaches the file; a `sh -c` chain is named by its last command that is not a `cd`.
- `--was '<stage>'` (repeatable, in pipeline order) names a `tail`, `head` or `grep` stage `out` stands in for, as `guard` passes them when it drops one: the session would have read what that stage printed, so the saving counts against it. Output that folding would not make shorter is printed untouched, so `out` never shows more than the command printed. A stage it cannot read (`tail -f`, a long grep option it does not know) counts the whole output.
- `out --stats [--since 7d] [--json]` prints the runs, how many were folded, the bytes printed and shown, and about how many tokens were saved (bytes / 4, an estimate), then the ten commands that saved the most, with the share of runs folded and, per command, the median share of the output a folded run cut.

## Wrapping from guard

The pure functions `guard` needs to wrap a command live in `src/wrap.ts`: `shouldWrap(command)` is true when every part of a command line is a listed noisy command (installs, builds, test runners, linters, `docker build`/`docker compose build|pull`, `just <recipe>`), with no pipe, redirect, background, substitution, `--json` or `--help`. A runner is known by its last path segment (`vendor/bin/phpunit`), through `php` (`php bin/phpunit`) and inside `docker compose exec|run` or `docker exec` (`docker compose exec -T php vendor/bin/paratest`). A line ending in pipes into `tail` or `head` keeping at least 150 lines (`-n 200`, `-200`, `--lines=200`), out's fold size, is wrapped with those stages and the `2>&1` feeding them dropped, since the folded output is no longer and keeps the failures they would have picked out; a `grep` or a shorter cut shows less than `out` would, so that line is left as it is. `wrap(command)` returns `out -- <command>`, through `sh -c '...'` for `&&` chains and leading `VAR=value` assignments, each dropped stage passed ahead as `--was '<stage>'`. The `guard` command imports them to rewrite a command into `out -- ...`; its Claude Code hook never wraps, since a hook cannot swap a command without approving it, and refuses with the command to run instead.
