# @kaynooo/cli-kit

What every @kaynooo CLI shares, so each one parses, helps and fails the same way.

```sh
bun add @kaynooo/cli-kit
```

It ships its TypeScript source and runs on Bun only (>= 1.4.3). The agent-tools CLIs take it as a `workspace:*` dev dependency and bundle it at build; a CLI elsewhere takes it from the registry as a dependency.

```ts
import { parse, runCli } from '@kaynooo/cli-kit'

process.exitCode = await runCli({
  name: 'tool',
  version: '1.0.0',
  about: 'does things',
  commands: {
    // A command imports its module when it runs, so `tool --help` loads none of them.
    build: { summary: 'build the project', run: async args => (await import('./commands/build')).run(args) },
  },
})
```

## Exit codes

0 for success, help and version; 2 for a usage error (an unknown command, a bad option, a missing argument, what `parse` and `fail` throw by default); 1 for a command that ran and failed (`fail(message, 1)`, or any other error a command throws).

## API

- `runCli({ name, version, about, commands, aliases })` dispatches `<cli> <command> [args]`: `--help` lists the commands, `--version` prints the version, a typo names the command it likely meant, and an `Exit` thrown by a command prints `<cli> <command>: <message>` and exits with its code.
- `parse(args, usage, options)` wraps `node:util` `parseArgs` with a generated `--help`; `fail(message, code = 2)` ends a command; `wholeNumber` reads a numeric option.
- `table`, `truncate`, `formatSeconds`, `formatAge` and `upTo` format output.
- `runMain({ name, version, run })` runs a CLI that is a single command: `--version` or `-v` alone prints the version, and an `Exit` or any error prints `<name>: <message>` and becomes the exit code. `await` it into `process.exitCode`.
- `runCli` also takes `defaultCommand`, the command that gets the arguments when the first one names no command (`db "select 1"` runs `db query "select 1"`), and a command may be a group, `{ summary, commands, aliases? }`, dispatched with its own help and typo hints (`ft plan add`).
- `<bin> __complete <words>... <word>` is answered by `runCli` and `runMain` for shell completion: the subcommands with their summaries, a leaf command's options (read by running it until its `parse` call throws them, so every command parses its arguments first), or `__files__` where a path fits.
- `parse(args, usage, options, { rest: true })` stops at the first `--` and returns what follows untouched as `rest` (`out -n 200 -- <cmd>`), `undefined` without a `--`.
- `readInput(path, { noStdin })` reads a file, or stdin when the path is `-`; a missing file or a stdin left on the terminal ends the command with a message.
- `runCommand(argv, { cwd, env, stdin })` runs a command and returns `{ code, text, output, chunks }`, the output of both streams (in arrival order, tagged by stream in `chunks`); it throws when the command cannot start. `exitCodeOf(code, signal)` is the exit code a shell reports.
- `stripAnsi(text)` removes colour and cursor codes, and `distance(a, b)` is the edit distance between two names.
- `table(rows, { cellWidth })` also flattens each cell's line breaks and cuts it to `cellWidth`, and `formatDuration(ms)` formats milliseconds like `formatSeconds` but with one decimal under a minute (`0.3s`).
- `capture(fn)` from `@kaynooo/cli-kit/test` runs a command in-process and returns `{ result, out, err }`, what it printed through `console` and `process.stdout`/`stderr`, so a test needs no spy.
- `@kaynooo/cli-kit/shell` reads shell command lines the way a hook vetting them needs: `splitCommand` cuts one into pieces at the separators outside quotes and heredocs, `parseCommand` names a piece's program past `sudo`/`env` wrappers and assignments, `tokenize`, `words`, `substitutions` and `replacePieces` take it apart and put it back.
