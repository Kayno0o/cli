# doctor

`doctor` checks a host's @kaynooo/cli-* install in one call: one line per check, the command that fixes a failing one beside it. The package also ships a second bin, `cli` (`cli stats`, `cli list`, `cli find`, below), which is not `doctor`.

```sh
bun install -g @kaynooo/cli-doctor
doctor           # one line per check
doctor --json    # [{check, ok, detail, fix?}]
doctor -q        # only the failing checks, nothing when all pass
doctor --only tea --only bun    # just these checks (a package such as cli-forgejo, tea, hooks, bun, completions)
doctor --fix --dry-run          # what --fix would run
doctor --fix     # run the fixes, then check again
doctor --install # pick the packages to add from a checklist
doctor --install forgejo check hooks   # or name them: a package, one of its bins, hooks, all
```

| Check | Passes when | Fix |
| --- | --- | --- |
| each `@kaynooo/cli-*` package | it is installed globally, its bins are on the PATH and it is no older than the version `bun info` serves | `bun install -g <package>@<latest>`, and one line installing every outdated package at once |
| `needs` | the system tools the installed packages need are on the PATH: glab for `gl`, docker for `dc`, `dlog`, `dx` and `sf` | install them by hand, doctor never installs a system package |
| `tea` | `ft` is installed, tea is installed, logged in to git.kaynooo.fr and `tea api version` answers, since `ft` goes through it | `tea login add --url https://git.kaynooo.fr --oauth` |
| `hooks` | `~/.claude/settings.json` wires the hooks one way: the `cli-hooks@kaynooo-cli` plugin enabled, or the `cli` mod listed in `CLAUDE_CODE_PLUGIN_DIRS`; both at once fails, every call being checked twice | `claude plugin install cli-hooks --marketplace ...`, or `claude plugin disable` for the doubled one |
| `bun` | Bun satisfies the `engines.bun` range of every installed package | `bun upgrade` |
| `completions` | fish is missing, or its folder holds a completion for every installed bin and none of ours for a bin no longer installed | `cli completions fish --install` |
| `dead-bins` | no link in Bun's bin folder points at a file of our packages that is gone, as `bun install -g` leaves the bins a newer version dropped | `rm` of those links, which `--fix` runs |
| `dl-bins` | `dl` is installed and no command it installed with `--bin` changed at its source, as `dl outdated --bins` tells; a source that does not answer is only noted | `dl update <name>...`, printed, not run |

Only the packages that are installed are checked: a package left out is no failure, and the last line counts them. A registry that does not answer leaves a package passing, with a note. Exit codes: 0 every check passed, 1 one failed, 2 a usage error.

## --install

`--install` adds packages: the names given (a package such as `forgejo`, one of its bins such as `ft`, `hooks` for the Claude Code plugin, or `all`), else a checklist on a terminal that shows each package's bins, what it does and what it needs. Off a terminal, names are required. Before installing, each package is checked against its needs: a missing required tool (tea for `ft`, glab for `gl`, docker for `dc`) leaves the package out unless `--force`, and `hooks` installs `guard` first. The installs run in one `bun install -g`, then the plugin, then the checks and fixes of what was installed. `--list` prints the choices and `--dry-run` what would run. Exits 1 when a package was left out.

## --fix

`--fix` runs the `fix:` lines it may: the `bun install -g` ones (joined into one call), `cli completions fish --install`, `claude plugin install` or `disable`, and the removal of dead bin links. It then checks again, prints the checks as they stand and exits on those. Nothing that installs a system package is run, and a line that only describes a step (`tea` from its releases page, adding a folder to the PATH, `bun upgrade`, which replaces Bun itself) is printed as `not run`. `--dry-run` prints each line as `would` and runs nothing (alone it implies `--fix`).
`--json` keeps its shape and prints the checks after the fixes, the fixes going to stderr; `--quiet` filters it to the failing ones.

## cli completions

```sh
cli completions fish --install            # one file per installed bin in ~/.cache/fish/kaynooo-cli
source <(cli completions bash)            # in ~/.bashrc
source <(cli completions zsh)             # in ~/.zshrc, after compinit
```

Each bin completes itself through `<bin> __complete`, and these are the scripts `<bin> --completions <shell>` prints (from `@kaynooo/cli-kit`), written for every installed bin at once. fish gets a file per bin, the stale ones this command wrote taken out, in `~/.cache/fish/kaynooo-cli` (or `$XDG_CACHE_HOME`); the folder has to be in `fish_complete_path`, first so a completion fish ships for the same name does not win: `set -p fish_complete_path ~/.cache/fish/kaynooo-cli`. bash and zsh get one script each on stdout, `--install` and `--dir` being fish's; for zsh run `autoload -U +X compinit && compinit` before sourcing it. The zsh one is untested, zsh not being installed here.

## cli config

```sh
cli config [--json]   # every config file a bin looks for (set, absent or invalid), the main variables set with secrets hidden, the workspace folder and the theme in force
```

It ends on the workspace folder and the theme in force; a token or webhook shows as hidden, and `docs/config.md` in the repository describes every key and variable. `~/.config/kaynooo-cli/doctor.json` takes `forgeHosts` (other hosts the same forge answers on) and `concurrency` (a positive whole number, 4 when unset), how many registry lookups run at once.

## cli stats

```sh
cli stats [--since 7d] [--json]   # runs per bin and per command, failures (exit 1) apart from usage errors (exit 2), and the options usage errors did not know
```

Every bin records each run in `~/.local/state/kaynooo-cli/usage.jsonl`: the bin, its command, the flag names it saw (never values or arguments), the exit code and, on a usage error, the unknown option (never its message). It also records how long each run took, and the commands whose 90th percentile took a second or more are listed slowest first, the ones worth a progress line or a speed-up. `failed` counts exits other than 0 and 2, usage errors being exit 2 (misuse, or a check that could not be made). `$XDG_STATE_HOME` moves the file. `KAYNOOO_CLI_NO_USAGE=1` turns it off; `guard` never records.

## cli list

```sh
cli list         # every bin in one line: what it does; instead of what
cli list git     # the bins whose name starts with the word, or whose package, summary or "instead of" holds it
cli list --json  # [{bin, package, installed, synopsis?, summary?, replaces?, examples?}]
cli              # on a terminal, a picker over the installed bins: the preview is the highlighted bin's --help, enter prints it
```

A bare `cli` is `cli find [word]`: the picker on a terminal, the same list as `cli list` anywhere else.

Each line is read from the bin's own `--help`, run with `KIT_HELP=json` (see the kit README), so it cannot drift from the usage and follows the installed version. A bin installed from before that prints its text help, whose first line is kept; one not installed is listed with the command installing it. The repo's `tests/describe.test.ts` holds every bin to a summary, a `replaces` and two examples naming it.
