# ft

Forgejo tools for the terminal: CI runs and their failures, releases, issue checklists and issue claims between Claude Code sessions.

```sh
bun install -g @kaynooo/forgejo-tools
```

Needs [tea](https://gitea.com/gitea/tea) logged in to the Forgejo instance (`tea login add`). Every call goes through `tea api`, so ft has no token of its own: tea owns the login and finds the repository from origin. Run ft from the repository, or pass `--repo owner/name` to the commands that take it.

## Commands

| Command | What it does |
| --- | --- |
| `ft runs` | recent runs with workflow, ref, duration and age (`-n`, `--sha`, `-w test.yml`, `--json`) |
| `ft ci [ref]` | waits for the push runs covering a commit on the default branch and prints each failed test's output |
| `ft watch` | waits for the runs in progress, or `--after <id>` those newer than a run |
| `ft logs <run>` | what the failed jobs of a run say went wrong, `--full` for whole logs |
| `ft release <level>` | `bun pm version`, one atomic push of branch and tag, then waits for the runs and the registry |
| `ft board` | open issues: available, taken by a live session, or claimed with no live session here |
| `ft take <n>` / `ft drop <n>` | claims or gives back an issue for the calling Claude Code session |
| `ft issue <n>` | an issue's claim and numbered checklist boxes |
| `ft tick <n> <box>...` | ticks boxes by number or text, `--undo` unticks |
| `ft fixed <n> [sha]` | comments `Fixed in <sha>: <subject>` and closes, refusing while boxes are left |
| `ft remote [--fix]` | switches an origin using an ssh alias (`forgejo:owner/repo`) to `git@<host>:owner/repo.git`, which tea matches |

`ft <command> --help` lists each command's options. Waiting commands exit 0 when the runs pass, 1 when one fails, 2 on a timeout, a stalled queue or bad usage.

## CI

`ft ci` follows every workflow a push starts. A run that was cancelled leaves the commit to the next push's runs, and so does one whose `--job` was skipped, as a workflow skipping its tests when a newer push is queued does; a tagged release commit whose tests were skipped passes, its tag's workflow testing it.

```sh
ft ci --workflow test.yml --job test   # kayjs: the test job is skipped when a newer push supersedes it
```

With an admin login, a queued run is checked against the runners: a job whose `runs-on` labels no online runner carries fails at once, and a queue no runner works on for 3 minutes fails with the reason.

## Releases

`ft release patch|minor|major` releases from the default branch, pushing any commits origin lacks along with the bump, which the tag workflow tests before it publishes. A refused push drops the bump commit and tag. A repo with its own bump script runs it, then `ft release --tagged`.

## Issue claims

Sessions claim an issue with a `Taken by session <name>.` comment and give it back with `Released by session <name>.`. `ft board` checks each claim against the Claude Code sessions running on this machine (`~/.claude/sessions` and `~/.claude-accounts/*/sessions`, pid and start time). A lane's claim (`lane-<n>-<issue>`) is held while the session named `*-<n>` runs. A claim no session here answers to may come from another machine, so `ft take` only takes it over with `--take-stale`.
