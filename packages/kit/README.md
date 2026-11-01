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

## Look

On a terminal, help has bold `Usage:`, `Commands:` and `Options:` headers, command and flag names in cyan and descriptions dimmed; an error reads as a red `error`, the dimmed `<cli> <command>:` and the message, with a yellow `hint` under it. Piped, in CI or under `NO_COLOR`, `NODE_DISABLE_COLORS` or `TERM=dumb`, the same text prints with plain words (`error: demo greet: give a name`, `  hint: run demo greet --help for its options`), so logs and what agents read stay greppable. `FORCE_COLOR` forces colours as `@kaynooo/utils` reads it.

## API

- `runCli({ name, version, about, commands, aliases })` dispatches `<cli> <command> [args]`: `--help` lists the commands, `--version` prints the version, a typo names the command it likely meant, and an `Exit` thrown by a command prints `error: <cli> <command>: <message>`, its hint under it, and exits with its code. Any other error exits 1, named by its class unless a plain `Error` (`error: tool sync: MigrationError: ...`), its cause's message on a `cause:` line under it when the cause is an `Error`; `redact(text)` rewrites both before they print, for errors that may quote what a log must not keep.
- `parse(args, usage, options)` wraps `node:util` `parseArgs` with a generated `--help` (`usage` given with or without its `usage:`), which prints the help and ends the command with exit 0 (it throws `HelpShown`, which `runCli` and `runMain` take), so the command needs no check after it. `{ positionals: ['<key>', '[file]'] }` names the positionals the command takes: `<key>` or `KEY` required, `[file]` optional, a last one ending in `...` taking any more; one missing (`missing <key>`) or one too many (`unexpected argument x`) is a usage error, and `positionals` comes back typed as `[string, string?]`. `fail(message, code = 2, hint?)` ends a command, the hint printed under the error; `badUsage(message)` ends it with a `UsageError`, which `parse`, `wholeNumber` and `duration` throw too and which gets the hint `run <cli> <command> --help for its options`; `wholeNumber` reads a numeric option.
- `table`, `truncate`, `formatSeconds`, `formatAge` and `upTo` format output.
- `runMain({ name, version, run })` runs a CLI that is a single command: `--version` or `-v` alone prints the version, and an `Exit` or any error prints `error: <name>: <message>` and becomes the exit code. `await` it into `process.exitCode`.
- `runCli` also takes `defaultCommand`, the command that gets the arguments when the first one names no command (`db "select 1"` runs `db query "select 1"`), its options listed in `<cli> --help` under the commands, and a command may be a group, `{ summary, commands, aliases? }`, dispatched with its own help and typo hints (`ft plan add`).
- `<bin> __complete <words>... <word>` is answered by `runCli` and `runMain` for shell completion: the subcommands with their summaries, a leaf command's options (read by running it until its `parse` call throws them, so every command parses its arguments first), or `__files__` where a path fits.
- `parse(args, usage, options, { rest: true })` stops at the first `--` and returns what follows untouched as `rest` (`out -n 200 -- <cmd>`), `undefined` without a `--`; `{ allowNegative: true }` takes `--no-<flag>` as `false` for a boolean flag.
- `readInput(path, { noStdin })` reads a file, or stdin when the path is `-`; a missing file or a stdin left on the terminal ends the command with a message.
- `runCommand(argv, { cwd, env, stdin })` runs a command and returns `{ code, text, output, chunks }`, the output of both streams (in arrival order, tagged by stream in `chunks`); it throws when the command cannot start. `exitCodeOf(code, signal)` is the exit code a shell reports.
- `holdSignals(cleanup?)` takes SIGINT, SIGTERM and SIGHUP over until `release()`: a signal goes to the child given to `forward(child)`, so the CLI exits with the child's code; without one, `cleanup(signal)` runs and the signal is raised again, ending the process as it would have; without either, it is only kept in `signal`, for the caller to wind down (`base` holds them while its worktree exists).
- `openUrl(target, env?)` opens a URL, or a file path made absolute, with the command `BROWSER` names or the platform's opener (`xdg-open`, `open`, `start`), without waiting; it returns `false` when that command cannot start.
- `jsonOption(holds?)` is the `--json` flag, worded `print JSON` or `print JSON: <holds>` alike in every CLI, and `printJson(value)` prints the value indented on stdout.
- `stripAnsi(text)` removes colour and cursor codes, and `distance(a, b)` is the edit distance between two names.
- `table(rows, { cellWidth, header })` also flattens each cell's line breaks and cuts it to `cellWidth`, and with `header` prints the first row bold on a terminal; and `formatDuration(ms)` formats milliseconds like `formatSeconds` but with one decimal under a minute (`0.3s`).
- `ok(text, detail?)`, `note`, `warn` and `problem` print a status line marked with a green ✓, a dimmed ·, a yellow ! or a red ✗ (`ok` and `note` on stdout, the others on stderr), the detail dimmed after the text; plain, the marks read `ok:`, `note:`, `warning:` and `error:`. `marked(mark, text, stream, detail?)` returns such a line, `paint(stream)` the colours for a stream and `takesControlCodes(stream)` whether it draws in place.
- `capture(fn)` from `@kaynooo/cli-kit/test` runs a command in-process and returns `{ result, out, err }`, what it printed through `console` and `process.stdout`/`stderr`, so a test needs no spy.
- `findUp(names, from?)` is the nearest of `names` in the current folder (or `from`) or one above it; `loadConfig(names, { from?, path? })` imports the nearest config (`.ts`, `.js` or `.json`), or the file `path` names, and returns `{ path, dir, config }` with its default export for the caller to check, `undefined` when there is none. A named file missing, one failing to import or one without a default export ends the command with exit 1.
- `@kaynooo/cli-kit/prompt` asks on the terminal, on stderr:
  - `select(question, choices, { initial })` picks one `{ value, label, hint }`: typing filters the choices (every word typed in the label or hint, case ignored, Backspace editing), the arrows move and Enter picks.
  - `checklist(question, choices, { initial, toggle })` checks several the same way, Space toggling the choice under the cursor; `toggle(checked, value)` returns what is checked after it, for choices that pull others along, and flips the one choice by default.
  - `confirm(question, { default })` answers y or n, Enter taking the default; `input(question, { default, mask, validate })` takes a line, `mask` drawing it as `*`, `validate(value)` returning a message shown under it until the answer passes.
  - Each answers `undefined` once Escape or Ctrl+C cancels and leaves `✓ <question> <answer>` or `✗ <question> cancelled`; a list longer than the terminal (10 rows at most) scrolls with the cursor, a dimmed `… n more` above and below.
  - Off a terminal, a prompt fails at once with exit 2, `cannot ask "<question>" off a terminal`, with `hint` under it when given (`{ hint: 'pass --yes' }`); none reads a piped line. Each takes a `terminal: { stdin, stderr }`, the process's by default, for a test to drive.
- `@kaynooo/cli-kit/progress` draws `progressLine(stream?, env?)` on stderr, one line redrawn in place while a task runs (`⠹ prerendering ████████░░░░░░░░░░░░ 8/20 routes 4.2s`, the bar cyan on a dimmed track), fed `update({ step, done?, total?, unit? })` and ended with `stop()`, `done(text)` leaving `✓ <text> <time>` or `failed(text)` leaving `✗ <text>`. It draws only where `takesControlCodes`; elsewhere `update` and `stop` do nothing and `done` and `failed` print their plain line. Anything printed meanwhile clears it first, and an interrupt clears it before the process ends.
- `task(label, run)` from `/progress` runs one step under a spinner, `run` given an `update({ done?, total?, unit? })` for a bar, and ends on `✓ <label> <time>`, or `✗ <label>` and the error thrown again.
- `taskList(stream?, env?)` from `/progress` stacks a progress line per task running side by side: `add(label)` returns `{ update, done(text?), failed(text?) }`, and a task ending leaves its `✓` or `✗` line above those still running.
- `liveRegion(render, stream?, env?)` from `/progress` is the block both draw with: the lines `render(spinner)` returns, redrawn every frame (`redraw()` draws at once), each cut to the terminal's width and the block to its height, `print(text)` printing above it and `stop()` clearing it. Like the progress line it draws only where `takesControlCodes`, and `ft ci` and `waitfor` show what they wait on with it.
- `badge(word, stream)` marks a status word on a terminal, the same five ways everywhere: `✓ success` green, `✗ failure` red, `● running` cyan, `○ waiting` yellow, `- skipped` dimmed; the word alone elsewhere. `statusOf(word)` reads the words Forgejo and GitLab report (`success`, `failed`, `pending`, `canceled`...) as `passed`, `failed`, `running`, `queued` or `skipped`.
- `keyValue(pairs)` aligns `label  value` lines, `sparkline(values)` draws `▁▃▇`, `bar(ratio)` and `barChart(rows)` draw cyan bars on a dimmed track, and `tree(roots)` hangs `{ label, children? }` nodes on dimmed `├─`, `└─` branches.
- `@kaynooo/cli-kit/shell` reads shell command lines the way a hook vetting them needs: `splitCommand` cuts one into pieces at the separators outside quotes and heredocs, `parseCommand` names a piece's program past `sudo`/`env` wrappers and assignments, `tokenize`, `words`, `substitutions` and `replacePieces` take it apart and put it back.
