# docker

Two docker compose helpers: `dc` runs compose on the stack found here, `dx` lists a stack's services and opens a shell in one, follows its logs, restarts, stops or rebuilds it.

```sh
bun install -g @kaynooo/cli-docker
```

## Commands

| Command | What it does |
| --- | --- |
| `dc <compose args>` | `docker compose` on the nearest compose file (or `.env` setting `COMPOSE_FILE`) up to the repository root |
| `dc <project> <compose args>` | the same on a stack that came up from other files (`-f docker-compose.prod.yaml --env-file .env.prod`), found through the labels compose put on its containers |
| `dx` | lists the services here with their state, ports and image (`--json` for the full record) |
| `dx <service> [action]` | `shell` (the default, `up` for a stopped service), `logs`, `restart`, `up`, `stop` or `build` |

`dc` takes no option of its own, every word reaches compose as typed. With several stacks that only have containers here and no name, it asks with `pick` when that is installed and a terminal is attached, and otherwise lists the projects. When it picked the stack through its containers it prints the compose command it stands for on stderr.

Services are named `php` for this folder's stack, `api/php` for a child folder's and `<project>:php` for a stack found through its containers; a bare name also finds the same service in a child folder.
