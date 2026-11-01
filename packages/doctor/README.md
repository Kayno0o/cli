# doctor

`doctor` checks a host's agent-tools install in one call: one line per check, the command that fixes a failing one beside it.

```sh
bun install -g @kaynooo/doctor-tools
doctor           # one line per check
doctor --json    # [{check, ok, detail, fix?}]
```

| Check | Passes when | Fix |
| --- | --- | --- |
| each `@kaynooo/*-tools` package | it is installed globally, its bins are on the PATH and it is no older than the version `bun info` serves | `bun install -g <package>@<latest>`, and one line installing every outdated package at once |
| `tea` | tea is installed, logged in to git.kaynooo.fr and `tea api version` answers, since `ft` goes through it | `tea login add --url https://git.kaynooo.fr --oauth` |
| `hooks` | `~/.claude/settings.json` wires the hooks one way: the `agent-tools-hooks@agent-tools` plugin enabled, or the `agent-tools` mod listed in `CLAUDE_CODE_PLUGIN_DIRS`; both at once fails, every call being checked twice | `claude plugin install agent-tools-hooks --marketplace ...`, or `claude plugin disable` for the doubled one |
| `bun` | Bun satisfies the `engines.bun` range of every installed package | `bun upgrade` |

A registry that does not answer leaves a package passing, with a note. Exit codes: 0 every check passed, 1 one failed, 2 a usage error.
