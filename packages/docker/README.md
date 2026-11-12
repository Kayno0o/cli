# docker

Four helpers: `dc` runs compose on the stack found here, `dx` lists a stack's services and opens a shell in one, follows its logs, restarts, stops or rebuilds it, `dlog` shows every service's health and recent errors, `sf` picks a Symfony console command and runs it.

```sh
bun install -g @kaynooo/cli-docker
```

## Commands

| Command | What it does |
| --- | --- |
| `dc <compose args>` | `docker compose` on the nearest compose file (or `.env` setting `COMPOSE_FILE`) up to the repository root |
| `dc <project> <compose args>` | the same on a stack that came up from other files (`-f docker-compose.prod.yaml --env-file .env.prod`), found through the labels compose put on its containers |
| `dx` | without a terminal (a script, a pipe, an agent) it lists the services with their state, ports and image, `--json` for the full record: that is the form to use there. On a terminal it picks one instead: enter opens its shell (or brings it up), ctrl-l follows its logs, ctrl-r restarts, ctrl-x stops, ctrl-b rebuilds; the ones acted on last come first |
| `dx -` | the last action again |
| `dx <service> [action]` | `shell` (the default, `up` for a stopped service), `logs`, `restart`, `up`, `stop` or `build` |
| `dx <service> logs --tail 50 --no-follow` | `--tail N` sets the lines (200), `--follow` and `--no-follow` force either way (followed on a terminal, printed once without one), `--no-follow` printing them once and exiting so a script or an agent gets them without hanging; `--tail` and the follow flags are refused for any other action. `shell` uses bash when the container has it |
| `dlog [service...]` | one line per service with its state and health, then the last distinct error lines of its logs (`-n` per service, `--since 1h`), a repeated message once with `×N` and secrets masked as `ev redact` does; `--all` adds the last lines of a quiet service. `--level warn` keeps warnings too and `--grep <regex>` keeps the lines matching a case insensitive regex instead of the error words. Exits 1 when a service is down or unhealthy or logged a line; `--fail-on down|unhealthy|errors` (repeatable, all three by default) picks what counts, so `--fail-on down --fail-on unhealthy` gates on health and ignores an old error still inside `--since` |
| `sf` | without a terminal (a script, a pipe, an agent) it lists the Symfony console commands with their description, `sf --list --json` adding arguments and options: that is the form to use there. On a terminal it picks a command and runs it, asking for each required argument; the commands run last come first, and the picker opens on the list cached from the last run. It runs in the php service of the nearest compose stack, else with the local php |
| `sf --list --json` | every command with its console folder, signature, arguments and options as JSON |
| `sf -` | the last command again, with the arguments it ran with |
| `sf <command> [args...]` | runs without the picker; a name the list does not hold goes to the console as is, which resolves `c:c` to `cache:clear` itself |

`sf` finds the nearest `bin/console` up to the repository root, then those of the child folders (keyed `api/cache:clear`); in a container, the working directory is taken to be the app. The hidden flags `--list`, `--names`, `--rows`, `--show`, `--record` and `--emit` are for term, tmux and the shell completions; `sf --json` is `sf --list --json`.

`dc` takes no option of its own, every word reaches compose as typed. With several stacks that only have containers here and no name, it asks with `pick` when that is installed and a terminal is attached, and otherwise lists the projects. When it picked the stack through its containers it prints the compose command it stands for on stderr.

Services are named `php` for this folder's stack, `api/php` for a child folder's and `<project>:php` for a stack found through its containers; a bare name also finds the same service in a child folder.

## Config

`~/.config/kaynooo-cli/dlog.json` (`$XDG_CONFIG_HOME/kaynooo-cli/` when set) takes `tail` (500 by default, the log lines read per service) and `width` (220, the longest error line kept) as positive whole numbers.
