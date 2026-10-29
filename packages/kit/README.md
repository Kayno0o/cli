# @kaynooo/cli-kit

What every agent-tools CLI shares, so each one parses, helps and fails the same way.

- `runCli({ name, version, about, commands, aliases })` dispatches `<cli> <command> [args]`: `--help` lists the commands, `--version` prints the version, a typo names the command it likely meant, and an `Exit` thrown by a command prints `<cli> <command>: <message>` and exits with its code.
- `parse(args, usage, options)` wraps `node:util` `parseArgs` with a generated `--help`; `fail(message, code = 2)` ends a command; `wholeNumber` reads a numeric option.
- `table`, `truncate`, `formatSeconds`, `formatAge` and `upTo` format output.
- `runMain({ name, version, run })` runs a CLI that is a single command: `--version` or `-v` alone prints the version, and an `Exit` or any error prints `<name>: <message>` and becomes the exit code. `await` it into `process.exitCode`.
- `runCli` also takes `defaultCommand`, the command that gets the arguments when the first one names no command (`db "select 1"` runs `db query "select 1"`), and a command may be a group, `{ summary, commands, aliases? }`, dispatched with its own help and typo hints (`ft plan add`).
- `parse(args, usage, options, { rest: true })` stops at the first `--` and returns what follows untouched as `rest` (`out -n 200 -- <cmd>`), `undefined` without a `--`.
- `readInput(path, { noStdin })` reads a file, or stdin when the path is `-`; a missing file or a stdin left on the terminal ends the command with a message.
- `runCommand(argv, { cwd, env, stdin })` runs a command and returns `{ code, text, output, chunks }`, the output of both streams (in arrival order, tagged by stream in `chunks`); it throws when the command cannot start. `exitCodeOf(code, signal)` is the exit code a shell reports.
- `stripAnsi(text)` removes colour and cursor codes, and `distance(a, b)` is the edit distance between two names.
- `table(rows, { cellWidth })` also flattens each cell's line breaks and cuts it to `cellWidth`, and `formatDuration(ms)` formats milliseconds like `formatSeconds` but with one decimal under a minute (`0.3s`).
- `capture(fn)` from `@kaynooo/cli-kit/test` runs a command in-process and returns `{ result, out, err }`, what it printed through `console` and `process.stdout`/`stderr`, so a test needs no spy.
