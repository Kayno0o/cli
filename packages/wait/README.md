# waitfor

Waits for a background build or server for Claude Code, where a session would otherwise `sleep 30; tail -c 2000 build.log` or hand-write an `until` loop: `waitfor` returns as soon as the log line shows, the port listens or the URL answers, and stops early on an error line.

```sh
bun install -g @kaynooo/wait-tools
waitfor --file server.log --until 'Listening on' --fail 'Error|FATAL' --timeout 2m
waitfor --port 5432
waitfor --url http://localhost:8000/health
```

## Behaviour

- `--file` is read from its start, line by line as each is completed, colours stripped; it may not exist yet. A file that shrinks (rotated, truncated) is read again from its start.
- `--until <regex>` waits for a line of `--file` to match and prints it as `<file>:<line>: <text>`.
- `--fail <regex>` ends the wait on the first matching line of `--file`, printing the five lines on each side of it on stderr, as long as some condition is still unmet: a `--until` line before it in the same read wins.
- `--port <n>` waits for a TCP connection to `--host` (127.0.0.1) to be accepted, `--url <url>` for a 2xx answer, redirects followed. Each prints how long it took.
- Every condition given must be met: `--port 8000 --file server.log --fail Error` waits for the port and gives up early when the log shows an error.
- `--timeout` takes `30s`, `5m`, `1h` or a bare number of seconds, 5 minutes by default. On a timeout stderr names what is still missing (the file absent, the connection error, the status answered) and the file's last 20 lines.
- Exit codes: 0 every condition met, 1 a `--fail` line, 2 a timeout or a usage error.
- Named `waitfor` so as not to shadow the shell's `wait`.
