# stack

A stable host port per service name for Claude Code, the same on every machine.

```sh
bun install -g @kaynooo/cli-stack
```

## Commands

| Command | What it does |
| --- | --- |
| `stack port <name>` | prints the port the name always hashes to (32-bit FNV-1a, 1024-32767), so a service keeps the same port on every machine |

`stack port` takes `--min` and `--max` to change the range: the default stops below 32768, where Linux starts handing out ephemeral ports, `--min` refuses anything under 1024, and `--max` goes up to 65535. The hash used to lose precision past 2^53 and the range ran to 65535, so every name now maps to a different port than before; a port already written in a compose file keeps working, only a newly picked one comes out different. When something on this machine already listens on the port it says so on stderr; the number is still printed and the exit code stays 0. `--json` prints `{name, port, listening}`.
