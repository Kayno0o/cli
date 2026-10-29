# stack

Two stack helpers for Claude Code: a stable port per service name, and an audit of a compose release setup against its `release.config.ts`.

```sh
bun install -g @kaynooo/stack-tools
```

## Commands

| Command | What it does |
| --- | --- |
| `stack port <name>` | prints the port the name always hashes to (FNV-1a, 1024-65535), so a service keeps the same port on every machine |
| `stack audit [dir]` | cross-checks `release.config.ts` in `dir` (the current directory) against the compose files it syncs |

`stack port` takes `--min` and `--max` to change the range. When something on this machine already listens on the port it says so on stderr; the number is still printed and the exit code stays 0.

## Audit

The checks, in the order they are reported:

- `sync` and `build`: every `deploySyncFiles` entry, `sourceDir`, `buildContext`, `dockerfile` and buildSecret `src` (a leading `~` is the home directory) exists, and a buildSecret `env` is set in the shell.
- `compose`: `docker compose config` succeeds on the base file and on each overlay merged over it. The base is the shortest compose file name among `deploySyncFiles`.
- `env`: every `${VAR}` without a default is in `requiredServerEnv`, and every listed key is referenced.
- `version`: each `versionEnv` is interpolated by a compose file, and each `*_VERSION` a compose file interpolates is declared by a release.
- `image`, `restart` and `post-deploy`: services the config names exist, and registry images are built by a release.
- `health` and `routing`: restarted services have a healthcheck, ports and traefik labels live in overlays, and `composeArgs` does not drop them.
- `layout`, `nuxt` and `gitignore`: bind mounts appear in the base file's header, `NUXT_*` variables match the runtime config, and `.release-logs` and `.release-worktrees` are ignored.

Exit codes: 0 no error (warnings allowed), 1 at least one error, 2 no `release.config.ts`. `--json` prints `{ root, composeFiles, findings }` where a finding is `{ level, check, message }`.

It needs docker for `docker compose config`. When the package `release.config.ts` imports `defineConfig` from is not installed, a stand-in that returns its argument is used.
