# wt

Git worktrees of a compose project, each with its own stack, its own copy of the data and its own `<task>.<host>` subdomains beside main.

```sh
bun install -g @kaynooo/cli-wt
```

`wt add planning` checks the project out on `wt/planning` next to main, copies the gitignored files main needs (env files, certificates), clones its volumes while main's containers are paused, rewrites the hosts in the copied env files to `planning.<host>`, and writes a compose override giving the worktree's routed services their [devproxy](https://git.kaynooo.fr/kaynooo/devproxy) labels. `wt up planning` starts it, `wt rm planning` stops it and deletes everything but its branches.

## Commands

| Command | What it does |
| --- | --- |
| `wt add <task> [branch] [--from <ref>] [--up]` | creates the worktree on `branch` (`wt/<task>`), a new one forked from main's current commit or `--from`, copies and clones from main, routes its subdomains; `--up` starts it too |
| `wt sync [task]` | provisions it again after a manifest change |
| `wt up [task]` / `wt down [task]` | starts or stops its stack, `--all` every worktree's in turn; `down` also stops a stack whose folder is gone |
| `wt rm <task>` | stops the stack, deletes the checkouts, volumes, certificates and override, keeps the branches; refuses uncommitted changes or commits on no branch unless `--force`; gitignored files (a copied `.env.local` edited since, uploads) go with the folder unchecked |
| `wt open [task]` | opens its main URL in the browser |
| `wt logs [task] [-f]` | prints the log of its last `--bg` job, or with `-f` follows its stack's compose logs |
| `wt prune [-a] [-y]` | lists what worktrees deleted by hand left behind (files, job records, volumes, git registrations) and removes it once confirmed |
| `wt ls` | main and the worktrees of the current project (`-a` every project), with their last job and changed files |
| `wt cd [task]` | goes to a worktree, or main, through the shell function of `wt shell` |
| `wt path [task]` | the directory of a worktree, or of main |
| `wt url [task]` / `wt tasks` | its URLs; the worktree names of the project, one per line |
| `wt doctor` | lists the programs wt runs (git, docker, compose, mkcert, devproxy, notify-send), where each is or how to get it; `wt add` refuses before changing anything when one it needs is missing |
| `wt init [dir]` | drafts a manifest from the compose project in `dir` into the manifests folder (`--print` to stdout) |
| `wt run <task> -- <cmd>` | runs a command in a throwaway container of the manifest's `run.service`, against a test database of the worktree's own |
| `wt heavy -- <cmd>` | runs a command once the heavy ones queued before it, from any session, are done |
| `wt shell fish\|bash\|zsh` | the shell function giving `wt cd <task>`, and `wt rm` leaving the folder it removed, with the completion |

A task defaults to the worktree the current directory is in, and `-p <name>` picks the project when the current directory is in none. `add`, `rm`, `up` and `down` take `--bg` to run detached, ending with a desktop notification. One action runs per stack at a time: a second one is refused, naming what holds it.

For `wt cd`, save the wrapper where the shell reads it at start, so no process runs then (again after upgrading wt): `wt shell fish > ~/.config/fish/conf.d/wt.fish`, or `wt shell bash > ~/.local/share/wt/wt.bash` sourced from `~/.bashrc` (zsh likewise, after `compinit`).

## Manifests

One file per project in `~/.config/wt/projects/<name>.ts`, `wt init` writing a first draft, and a `tsconfig.json` beside it pointing `@kaynooo/cli-wt` at the installed wt so an editor type-checks the manifests (delete it to have the next `wt init` write it again after moving wt):

```ts
import type { ProjectConfig } from '@kaynooo/cli-wt'

export default {
  root: '~/Workspace/times',
  repos: [],
  copy: ['.env', 'api/.env.local', '.docker/nginx/certs'],
  clone: ['mailpit'],
  certs: '.docker/nginx/certs',
  setup: ['docker compose exec -T api-php composer install'],
  routes: [
    { host: 'times.localhost', to: 'client' },
    { host: 'api.times.localhost', to: 'api-php:443', passthrough: true },
  ],
} satisfies ProjectConfig
```

| Key | |
| --- | --- |
| `root` | the main checkout |
| `repos` | nested repos put on the task branch; none when the root itself is the repo |
| `copy` | gitignored files and folders copied from main, hosts rewritten in the `.env*` ones |
| `clone` | data each worktree gets its own copy of: a path under root or a named volume's key |
| `link` | paths shared with main through a symlink |
| `skip` | services left out of a worktree's stack |
| `routeHosts` | services that dial the stack's own hosts from inside a container, given the worktree's in `/etc/hosts` |
| `env` | values forced into copied env files, per file; `{task}` and `{port}` (the dev server's) filled in |
| `ports` | a worktree's dev server port by task, from 1024 to 65535, for one whose port, hashed from its name, is taken: `wt add` warns when something listens on it, `wt sync` when another worktree has it |
| `certs` | where the stack's nginx reads certificates, required by passthrough routes |
| `setup` | `sh -c` commands run in the worktree the first time its stack comes up |
| `run` | `wt run`'s `service`, `dir`, `provision` commands, optional `dns` and `env` |
| `routes` | none leaves the worktree unrouted; `host` main answers on, `to` `client` (the dev server on the host) or `<service>:<port>`, `passthrough` to leave TLS to the stack |

## Config

`~/.config/wt/config.ts` (`$WT_CONFIG`), every key optional:

```ts
import type { WtConfig } from '@kaynooo/cli-wt'

export default {
  runner: { up: ['mystack', 'up', '{project}/{task}'] },
} satisfies WtConfig
```

| Key | Default | |
| --- | --- | --- |
| `manifests` | `<config dir>/projects` | the manifests folder |
| `worktrees` | `{root}/.worktrees/{repo}` | where a project's worktrees go, `{root}` the main checkout's parent, `{repo}` its folder name |
| `overrides` | `~/.local/share/wt/overrides` | the generated compose overrides |
| `state` | `~/.cache/wt` | setup markers, clone progress, queues |
| `jobs` | `<state>/jobs` | job records and per-stack locks; a tool pointing at the same folder shares the locks |
| `proxyNetwork` | `proxy` | the network devproxy reaches the stacks on |
| `runner` | | `up`, `down` and `removed` argv replacing `docker compose up -d --build`, `docker compose down` and nothing; `{project}`, `{task}`, `{dir}` and `{id}` filled in; a worktree whose folder is gone skips `down`, `{dir}` having gone with it, for `docker compose -p <id> down` |

Without a runner, `wt up` brings devproxy up first when it is installed (on PATH or as this package's dependency), then compose, then the manifest's `setup` once. A runner command that itself runs wt, or another tool sharing the `jobs` folder, works inside the job that started it instead of being refused by its lock.

## Library

`import { loadProjects, worktreeOf, Jobs, runSetup } from '@kaynooo/cli-wt'` for tools built on the same manifests: projects and worktrees, compose helpers, the job locks and the setup step.

Exit codes: 0 done, 1 refused or failed, 2 a usage error; `wt run` and `wt heavy` exit with the command's code.
