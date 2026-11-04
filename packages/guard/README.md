# guard

The safety rules a Claude Code Bash call is held to, run by a hook or by hand: each refusal names the rule and the route to take instead.

```sh
bun install -g @kaynooo/cli-guard
guard check 'git stash && ssh prod'
guard check --json --cwd "$PWD" - < command.txt
```

## Rules

| Rule | Refuses | Lives in |
| --- | --- | --- |
| `remote` | `ssh`, `scp`, `sftp`, `mosh`, `rsync` to a host, `DOCKER_HOST=ssh://`, `docker -H ssh://` | `src/remote.ts` |
| `git` | `git stash` (pointing at `proof`, `base`, a commit first or `git worktree add`), `git add -A`/`.`/`-u`, `git commit -a` in any flag cluster, `git push` the user did not ask for, `git push --tags` without `--atomic` | `src/git.ts` |
| `destructive` | `git reset --hard`, discarding the whole tree (`checkout -- .`, `checkout -f`, `restore .`, `switch -f`), `git clean -f`, a force push (`--force`, `-f`, `--mirror`, `+refspec`; `--force-with-lease` passes), `git branch -D`, a `git rebase` (`--continue` and `--abort` pass), `filter-branch`, `rm -r` on `/`, `~`, `$HOME`, `.`, `..`, `*` or a top-level directory, a download piped into a shell (`curl ... \| sh`, `bash <(curl ...)`); each refusal names the safe route: a commit with `gc` first, `base`, `git worktree add`, `--force-with-lease` | `src/destructive.ts` |
| `commit` | a commit message breaking the format: no Conventional Commit title, a trailer, a body over two lines, a bullet list, a hard wrap; `-m`, `-F <file>` and `-F -` with a heredoc are read; the refusal spells the rule out and points at `gc` | `src/commit.ts`, the validator in `@kaynooo/cli-git` |
| `sql` | a SQL client, console or dump tool fed a write (INSERT, UPDATE, DELETE, DDL, migrations, fixtures) outside a test database | `@kaynooo/cli-db` (`src/clients.ts`, `src/guard.ts`) |
| `env` | a command reading, writing or printing an env file or the whole environment; `guard path` refuses a file tool opening one | `@kaynooo/cli-env` (`src/guard.ts`) |
| `package-manager` | an install with another manager than the nearest lockfile pins, when it cannot be translated | `@kaynooo/cli-pkg` (`src/pin.ts`) |
| `pkg` | on the hook only, an install `pkg check` refuses or cannot check, pointing at `pkg <name>` before adding it | `@kaynooo/cli-pkg` |
| `edit` | when `sub` is installed, a `sed -i` and a python, bun or node script replacing text in a file (`-c`, `-e` or a heredoc), handing over the `sub` command doing the same where its `s` commands or `.replace(...)` calls take literals | `src/replace.ts` |

Every rule reads the command with one shell parser (`packages/kit/src/shell.ts`): quotes, heredoc bodies (text, never commands), `env`/`sudo`/`command` wrappers and subshells.

## Behaviour

- `guard rules [--json]` lists every rule with what it refuses, its route and where it runs. A test checks that `guard check` and `guard hook` give the same refusals for a corpus of commands.
- `guard check <command>` takes the command as one argument, or from stdin with `-` or when none is given; `--cwd` is the directory it runs in, for the files and lockfiles the rules read.
- Clean: nothing printed, exit 0. Broken: one `<rule>: <route>` line per broken rule, exit 1.
- Some rules rewrite rather than refuse: an install with the wrong manager runs with the pinned one, and a noisy test, lint or build run goes through `out` when it is installed (`--no-wrap` to skip). The text output says `runs as: <command>` and why.
- `--push-asked` lets `git push` through, for a hook that knows the user asked for one.
- `--json` prints `{ violations: [{ rule, message }], command, notes, packages }` for a hook: `command` is what to run instead, `notes` what a rewrite changed, `packages` the registry packages the command adds, for `pkg` to check first.
- `guard path <path>...` checks the paths a Read, Edit or Write would open.
- Exit codes: 0 clean, 1 a rule broken, 2 a usage error.

## Claude Code hooks

`guard hook <event>` speaks Claude Code's hook protocol, the event JSON on stdin and the reply JSON on stdout; the `cli-hooks` plugin at the repo root registers it (see the root README).

- `pre-tool-use`: a Bash call breaking a rule is denied with the routes, an install with the wrong manager with the command to run instead, an install `pkg` refuses with its report; a Read, Edit or Write of an env file is denied.
- `user-prompt-submit`: a prompt naming a push lets `git push` through until the next prompt; the state sits in `$XDG_STATE_HOME/guard/push-asked/<session>`, an empty file left behind by each session that ended on such a prompt. Claude Code sends no origin with the event, so a prompt it sends itself (a notification, a peer session's message) counts too, where the dotfiles mod counts only what the user typed.
- `session-start`: the installed @kaynooo/cli-* bins, one line each, handed to Claude as context.
- Nothing printed lets the call go ahead. Any failure exits 1, which Claude Code reports without blocking, never 2, which would block.
