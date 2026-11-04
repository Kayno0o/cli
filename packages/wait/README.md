# waitfor and slot

`slot` is documented after `waitfor`, below.

Waits for a background build or server for Claude Code, where a session would otherwise `sleep 30; tail -c 2000 build.log` or hand-write an `until` loop: `waitfor` returns as soon as the log line shows, the port listens or the URL answers, and stops early on an error line.

```sh
bun install -g @kaynooo/cli-wait
waitfor --file server.log --until 'Listening on' --fail 'Error|FATAL' --timeout 2m
waitfor --port 5432
waitfor --url http://localhost:8000/health
waitfor --pid 4242
waitfor task b92stimuo
```

## Behaviour

- `--file` is read from its start, line by line as each is completed, colours stripped; it may not exist yet. A file that shrinks (rotated, truncated) is read again from its start.
- `--until <regex>` waits for a line of `--file` to match and prints it as `<file>:<line>: <text>`.
- `--fail <regex>` ends the wait on the first matching line of `--file`, printing the five lines on each side of it on stderr, as long as some condition is still unmet: a `--until` line before it in the same read wins.
- `--port <n>` waits for a TCP connection to `--host` (127.0.0.1) to be accepted, `--url <url>` for a 2xx answer, redirects followed. Each prints how long it took.
- `--pid <n>` waits for the process to exit, checked with signal 0, so it never matches its own shell the way a `while pgrep -f` loop does. A zombie counts as exited. A `--port` connection attempt is given up after 3 seconds and retried, so dropped packets do not hold a poll for minutes.
- `waitfor task <id | file>` waits for a Claude Code background Bash task to end, its id found under `$CLAUDE_CODE_TMPDIR` (or `$TMPDIR`, `/tmp`) in `claude-<uid>/*/*/tasks/<id>.output`, then prints its exit code, its last 20 lines (`-n`) and the `(fail)` and `error:` lines above them, the last 30. It exits 0 when the task exited 0, 1 on another code, 2 on a timeout with the last lines; a path that does not exist fails at once with 2, and a subagent's id is refused, its notification reporting its end. `--json` prints `{task, path, code, ms, failures, tail}`, each line as `{number, text}`.
- `--json` prints `{met, ms, line}` once met, or on a `--fail` line with `met` false, `line` being the last `--until` line or the `--fail` one as `{number, text}`; the progress lines go to stderr. `--quiet` drops the live progress line, on `waitfor task` too.
- Every condition given must be met: `--port 8000 --file server.log --fail Error` waits for the port and gives up early when the log shows an error.
- `--timeout` takes `30s`, `5m`, `1h` or a bare number of seconds, 5 minutes by default. On a timeout stderr names what is still missing (the file absent, the connection error, the status answered) and the file's last 20 lines.
- Exit codes: 0 every condition met, 1 a `--fail` line, 2 a timeout or a usage error.
- Named `waitfor` so as not to shadow the shell's `wait`.

# slot

Heavy commands from parallel Claude Code sessions (phpunit, playwright, vue-tsc, eslint) queue behind a machine-wide set of slots instead of overloading the machine, and a named lock keeps two runs off one shared resource such as a test database.

```sh
slot -- bunx vue-tsc
slot --lock booki-test-db -- vendor/bin/phpunit
slot -n 6 -t 10m -- bun test
slot ls
check --slot
```

## Behaviour

- `slot -- <cmd>` waits for a free slot, runs the command with the terminal's stdin, stdout and stderr and exits with its code (a signal's `128 + n`, 127 when it cannot start). The slots are shared by every session, worktree and shell of the user; there are half as many as CPUs by default, `-n` sets the count (every caller should use the same one).
- `--lock <name>` also holds a named lock, repeatable, across sessions and worktrees. The locks and the slot are taken all together or not at all: a command waiting for one gives back what it got, so it never occupies a slot while it waits for a lock, nor holds a lock while it waits for a slot. The price is no queue: a command wanting a lock and a slot can wait long behind a stream of short holders of either. `--no-slot` takes the locks alone.
- Slots and locks are `flock`s on files, called through `bun:ffi`: the kernel drops one with its holder, so a `slot` killed with SIGKILL frees what it held, and nothing is cleaned up by pid or timestamp. The command it started is not killed with it: it keeps running with its slot and lock already freed, so the lock no longer protects it.
- A `slot` inside a slotted command does not wait for another slot or for a lock the outer one holds (the `SLOT_HOLDING` variable lists them), so a script and the commands it runs may both be wrapped, and `check --slot` over a script calling `slot --lock` cannot deadlock against a session waiting for a slot while it holds that lock, since a waiter holds nothing.
- When it has to wait, stderr gets one line naming who holds what it needs: the session, the command and for how long. `--timeout` (`-t`, `30s`, `5m`, a bare number of seconds) gives up with exit 2; it waits forever by default.
- `slot ls` lists the holders (`slot 2`, `lock booki-test-db`) and the waiters with their session (found as `ft take` finds it, through `~/.claude/sessions`), command and age, `--json` as `{slots, busy, entries}`. A waiter that died is dropped from the list.
- `slot ls` is the listing even as a first word, `slot -- ls` being read as `slot ls` because Bun drops a leading `--`: write `slot -n 4 -- ls` for the command.
- State lives in `$XDG_RUNTIME_DIR/kaynooo-cli/slot` (`~/.cache/kaynooo-cli/slot` without it), only the user can enter it; `$SLOT_DIR` points elsewhere.
- Exit codes: the command's, 2 on a timeout or a usage error.
