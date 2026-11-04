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
| `dx` | picks a service with fzf: enter opens its shell (or brings it up), ctrl-l follows its logs, ctrl-r restarts, ctrl-x stops, ctrl-b rebuilds; the ones acted on last come first. Without fzf or a terminal it lists them with their state, ports and image (`--json` for the full record) |
| `dx -` | the last action again |
| `dx <service> [action]` | `shell` (the default, `up` for a stopped service), `logs`, `restart`, `up`, `stop` or `build` |
| `dlog [service...]` | one line per service with its state and health, then the last distinct error lines of its logs (`-n` per service, `--since 1h`), a repeated message once with `×N` and secrets masked as `redact` does; `--all` adds the last lines of a quiet service. Exits 1 when a service is down or unhealthy or logged an error |
| `sf` | picks a Symfony console command with fzf and runs it, asking for each required argument; the commands run last come first, and the picker opens on the list cached from the last run. It runs in the php service of the nearest compose stack, else with the local php. Without fzf or a terminal it lists the commands |
| `sf --list --json` | every command with its console folder, signature, arguments and options as JSON |
| `sf -` | the last command again, with the arguments it ran with |
| `sf <command> [args...]` | runs without the picker; a name the list does not hold goes to the console as is, which resolves `c:c` to `cache:clear` itself |

`sf` finds the nearest `bin/console` up to the repository root, then those of the child folders (keyed `api/cache:clear`).

`dc` takes no option of its own, every word reaches compose as typed. With several stacks that only have containers here and no name, it asks with `pick` when that is installed and a terminal is attached, and otherwise lists the projects. When it picked the stack through its containers it prints the compose command it stands for on stderr.

Services are named `php` for this folder's stack, `api/php` for a child folder's and `<project>:php` for a stack found through its containers; a bare name also finds the same service in a child folder.
