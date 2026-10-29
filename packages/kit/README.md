# @kaynooo/cli-kit

What every agent-tools CLI shares, so each one parses, helps and fails the same way.

- `runCli({ name, version, about, commands, aliases })` dispatches `<cli> <command> [args]`: `--help` lists the commands, `--version` prints the version, a typo names the command it likely meant, and an `Exit` thrown by a command prints `<cli> <command>: <message>` and exits with its code.
- `parse(args, usage, options)` wraps `node:util` `parseArgs` with a generated `--help`; `fail(message, code = 2)` ends a command; `wholeNumber` reads a numeric option.
- `table`, `truncate`, `formatSeconds`, `formatAge` and `upTo` format output.
