# cli (`@kaynooo/cli-doctor`)

`cli` is the single hub for managing, discovering, configuring, and diagnosing `@kaynooo/cli-*` packages on a host.

```sh
bun install -g @kaynooo/cli-doctor

cli                          # interactive picker over installed bins (lists off a terminal)
cli list [word]              # one-line overview of every bin
cli add git check            # install packages or hooks (or `cli add all`)
cli remove gloss             # uninstall packages or hooks
cli manage                   # interactive checklist to install/remove packages
cli update [--dry-run]       # update installed @kaynooo/cli-* packages, dl bins & completions
cli doctor [--fix]           # check host setup (versions, needs, tea, hooks, bun, completions, dead links)
cli config [show|get|set|unset|edit|init]
cli completions <fish|bash|zsh>
cli stats [--since 7d] [--mode agent]
cli theme [preset]
```

## `cli doctor`

Checks this host's `@kaynooo/cli-*` install in one call: one line per check with the command that fixes a failing one beside it.

```sh
cli doctor                          # one line per check
cli doctor --offline                # skip registry and remote release lookups
cli doctor --json                   # [{check, ok, detail, fix?}]
cli doctor -q                       # only the failing checks, nothing when all pass
cli doctor --only tea --only bun    # just these checks
cli doctor --fix --dry-run          # preview fixes without running them
cli doctor --fix                    # run safe fixes, then check again
```

| Check | Passes when | Fix |
| --- | --- | --- |
| each `@kaynooo/cli-*` package | installed globally, bins on PATH, no older than `bun info` | `bun install -g <package>@<latest>` |
| `needs` | required system tools for installed packages are on PATH | install by hand (never auto-installed) |
| `tea` | `tea` (or `gt`) is configured and answers `version` | `tea login add --url https://<forge> --oauth` |
| `hooks` | `~/.claude/settings.json` wires `cli-hooks@kaynooo-cli` plugin or `cli` mod (not both) | `claude plugin install` / `disable` |
| `bun` | Bun satisfies `engines.bun` of every installed package | `bun upgrade` (printed, never auto-run) |
| `completions` | fish completion files or bash/zsh rc source line are up to date | `cli completions fish --install` or rc append |
| `dead-bins` | no dangling symlinks in Bun's bin folder pointing into `@kaynooo/cli-*` | `rm` dead links |
| `dl-bins` | commands installed via `dl --bin` are current | `dl update <name>...` |

## `cli add` / `cli remove` / `cli manage` / `cli update`

- `cli add [name...|all] [--list] [--dry-run] [--force]`: installs packages by package name, bin name, `hooks`, or `all`, skipping any whose required system tool is missing unless `--force`.
- `cli remove <name...> [--dry-run]`: uninstalls packages (or `hooks`).
- `cli manage [--dry-run] [--force]`: opens an interactive checklist to install and remove packages.
- `cli update [--dry-run] [--offline]`: updates installed `@kaynooo/cli-*` packages, `dl` bins, completions, and cleans dead links without running unrelated checks.

## `cli completions`, `cli config`, `cli stats`, `cli theme`, `cli list`

- `cli completions fish --install` writes one file per installed bin in `~/.cache/fish/kaynooo-cli`; `source <(cli completions bash|zsh)` loads completions in bash/zsh.
- `cli config` inspects active config files and env vars; `get`/`set`/`unset`/`edit`/`init` manage `~/.config/kaynooo-cli/config.jsonc`.
- `cli stats [--since 7d] [--mode <terminal|agent|ci|pipe>]` summarizes usage and usage errors from `~/.local/state/kaynooo-cli/usage.jsonl`.
- `cli theme [preset]` previews the active theme or a named preset.
- `cli list [word]` / bare `cli` lists or fuzzy-picks every bin from its live `KIT_HELP=json` output.
