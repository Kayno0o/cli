# guard

The safety rules a Claude Code Bash call is held to, run by a hook or by hand: each refusal names the rule and the route to take instead.

```sh
bun install -g @kaynooo/guard-tools
guard check 'git stash && ssh prod'
guard check --json --cwd "$PWD" - < command.txt
```

## Rules

| Rule | Refuses | Lives in |
| --- | --- | --- |
| `remote` | `ssh`, `scp`, `sftp`, `mosh`, `rsync` to a host, `DOCKER_HOST=ssh://`, `docker -H ssh://` | `src/remote.ts` |
| `git` | `git stash` (pointing at `base`), `git add -A`/`.`/`-u`, `git commit -a` in any flag cluster, `git push` the user did not ask for, `git push --tags` without `--atomic` | `src/git.ts` |
| `commit` | a commit message breaking the format: no Conventional Commit title, a trailer, a body over two lines, a bullet list, a hard wrap; `-m`, `-F <file>` and `-F -` with a heredoc are read | `src/commit.ts`, the validator in `@kaynooo/git-tools` |
| `sql` | a SQL client, console or dump tool fed a write (INSERT, UPDATE, DELETE, DDL, migrations, fixtures) outside a test database | `@kaynooo/db-tools` (`src/clients.ts`, `src/guard.ts`) |
| `env` | a command reading, writing or printing an env file or the whole environment; `guard path` refuses a file tool opening one | `@kaynooo/env-tools` (`src/guard.ts`) |
| `package-manager` | an install with another manager than the nearest lockfile pins, when it cannot be translated | `@kaynooo/pkg-tools` (`src/pin.ts`) |

Every rule reads the command with one shell parser (`packages/kit/src/shell.ts`): quotes, heredoc bodies (text, never commands), `env`/`sudo`/`command` wrappers and subshells.

## Behaviour

- `guard check <command>` takes the command as one argument, or from stdin with `-` or when none is given; `--cwd` is the directory it runs in, for the files and lockfiles the rules read.
- Clean: nothing printed, exit 0. Broken: one `<rule>: <route>` line per broken rule, exit 1.
- Some rules rewrite rather than refuse: an install with the wrong manager runs with the pinned one, and a noisy test, lint or build run goes through `out` when it is installed (`--no-wrap` to skip). The text output says `runs as: <command>` and why.
- `--push-asked` lets `git push` through, for a hook that knows the user asked for one.
- `--json` prints `{ violations: [{ rule, message }], command, notes, packages }` for a hook: `command` is what to run instead, `notes` what a rewrite changed, `packages` the registry packages the command adds, for `pkg` to check first.
- `guard path <path>...` checks the paths a Read, Edit or Write would open.
- Exit codes: 0 clean, 1 a rule broken, 2 a usage error.
