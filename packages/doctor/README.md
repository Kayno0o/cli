# doctor

`doctor` checks a host's @kaynooo/cli-* install in one call: one line per check, the command that fixes a failing one beside it. The package also ships a second bin, `cli` (`cli stats`, `cli list`, below), which is not `doctor`.

```sh
bun install -g @kaynooo/cli-doctor
doctor           # one line per check
doctor --json    # [{check, ok, detail, fix?}]
```

| Check | Passes when | Fix |
| --- | --- | --- |
| each `@kaynooo/cli-*` package | it is installed globally, its bins are on the PATH and it is no older than the version `bun info` serves | `bun install -g <package>@<latest>`, and one line installing every outdated package at once |
| `tea` | tea is installed, logged in to git.kaynooo.fr and `tea api version` answers, since `ft` goes through it | `tea login add --url https://git.kaynooo.fr --oauth` |
| `hooks` | `~/.claude/settings.json` wires the hooks one way: the `cli-hooks@kaynooo-cli` plugin enabled, or the `cli` mod listed in `CLAUDE_CODE_PLUGIN_DIRS`; both at once fails, every call being checked twice | `claude plugin install cli-hooks --marketplace ...`, or `claude plugin disable` for the doubled one |
| `bun` | Bun satisfies the `engines.bun` range of every installed package | `bun upgrade` |

A registry that does not answer leaves a package passing, with a note. Exit codes: 0 every check passed, 1 one failed, 2 a usage error.

## cli stats

```sh
cli stats [--since 7d] [--json]   # runs per bin, failures, and the options usage errors did not know
```

Every bin records each run in `~/.local/state/kaynooo-cli/usage.jsonl`: the bin, its command, the flag names it saw (never values or arguments), the exit code and, on a usage error, the unknown option. `KAYNOOO_CLI_NO_USAGE=1` turns it off; `guard` never records.

## cli list

```sh
cli list         # every bin in one line: what it does; instead of what
cli list --json  # [{bin, package, installed, synopsis?, summary?, replaces?, examples?}]
```

Each line is read from the bin's own `--help`, run with `KIT_HELP=json` (see the kit README), so it cannot drift from the usage and follows the installed version. A bin installed from before that prints its text help, whose first line is kept; one not installed is listed with the command installing it. The repo's `tests/describe.test.ts` holds every bin to a summary, a `replaces` and two examples naming it.
