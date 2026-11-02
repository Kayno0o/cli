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
| `ft logs <run>` | what the failed jobs of a run say went wrong, `-j <name or id>` picks a job, `--full` for whole logs |
| `ft release <level>` | waits for the runs on HEAD, pushing it first when origin lacks it, then `bun pm version`, one atomic push of branch and tag, and waits for the runs and the registry; `-p <folder>` releases one workspace package as `<folder>-v<version>` |
| `ft board` | open issues: available, taken by a live session, or claimed with no live session here, each claim with its boxes left and a stale one with its latest note (`-q <regex>` on titles, `--state available\|taken\|away`, `-L`, `-m <milestone>`, `--json`) |
| `ft digest` | one screen for a session starting cold: the issues this session holds with their boxes left, claims no live session answers to, red or running CI on the default branch, unpushed commits, dirty files and TODO comments naming a closed issue (needs `todo-scan` on the PATH; empty sections left out, `--json`) |
| `ft take <n>...` / `ft drop <n>...` | claims or gives back issues for the calling Claude Code session, `--lane` as `lane-<s>-<n>` |
| `ft issue <n>...` | an issue's state, claim and description, its checklist boxes numbered in place (`-c` comments, `-t` only the boxes left, `-b` only the raw description to edit, `--json`) |
| `ft new -t <title>` | creates an issue and prints its number and url; `-F <file>` (`-F -` for stdin) is the description, `-L a,b` the labels and `-m <milestone>` the milestone, refused before anything is created when the repository lacks one |
| `ft edit <n>` | replaces the title (`-t`) and/or the description (`-F <file>`, `-F -` for stdin); `--append` adds the `-F` text after the description instead, `--add-box <text>` (repeatable) an unticked box after the last one, `-m <milestone>` moves it to a milestone and `-m ''` takes it out |
| `ft tick <n> <box>...` | ticks boxes by number or text, `--undo` unticks, `-m <text>` or `-F <file>` comments too; `--closed` ticks instead every `- [ ] #<n>` line of a release plan whose issue is closed |
| `ft comment <n> [text]` | comments on an issue, from `-F <file>` or stdin when no text is given, so a heredoc needs no escaping |
| `ft fixed <n> [sha]...` | comments `Fixed in <a>, <b> and <c>: <subject>` and closes; with no sha it takes the commits on origin's default branch naming `#<n>` and says which; refuses while boxes are left unless `--tick` ticks them first; then ticks its `- [ ] #<n>` line in every open issue listing it, and names those |
| `ft close <n>... [-m reason]` | closes issues no commit fixed (a duplicate, one dropped), posting the reason first; `ft reopen` reopens them the same way |
| `ft label <n> [+]a -b` | adds the labels named bare or with `+`, removes those named with `-`, refusing one the repository lacks, and prints the issue's labels |
| `ft plan add <plan> <n>...` / `ft plan carry <from> <to>` | adds `- [ ] #<n> <title>` lines to a release plan's checklist, or copies one plan's unticked `#<n>` lines into the next, both under `--section "Bugs:"` (created when missing) and skipping issues already listed |
| `ft milestones` | lists the milestones (`--state open\|closed\|all`, `--json`) with the issues open and closed in each, the progress and the due date |
| `ft milestone <title\|id>` | shows a milestone's open issues as `ft board` does (available, taken, claimed by one gone); `ft milestone new <title> [-d text] [--due YYYY-MM-DD]` creates one through the API, sending no `due_on` unless `--due` is given, never a zero date; `ft milestone close <m>` refuses while issues are open in it, naming them, unless `--force` |
| `ft remote [--fix]` | switches an origin using an ssh alias (`forgejo:owner/repo`) to `git@<host>:owner/repo.git`, which tea matches; the host comes from `--host` or `remoteHost` in `~/.config/ft/config.json` (`{"remoteHost": "git.example.com"}`), and with neither it checks nothing |

`ft <command> --help` lists each command's options. Waiting commands show one line per run with how long it has been waiting or running (`● running for 1m 12s`), redrawn in place on a terminal and left at its last status with the time it took (`✓ success in 3m 2s`), and a line per status change in a log or a pipe; they exit 0 when the runs pass, 1 when one fails, 2 on a timeout, a stalled queue or bad usage; the other commands exit 0 when done, 1 when Forgejo refuses or a check fails, 2 on a usage error.

## CI

`ft ci` follows every workflow a push starts. A run that was cancelled leaves the commit to the next push's runs, and so does one whose `--job` was skipped, as a workflow skipping its tests when a newer push is queued does; a tagged release commit whose tests were skipped passes, its tag's workflow testing it.

```sh
ft ci --workflow test.yml --job test   # kayjs: the test job is skipped when a newer push supersedes it
```

With an admin login, a queued run is checked against the runners: a job whose `runs-on` labels no online runner carries fails at once, and a queue no runner works on for 3 minutes fails with the reason.

## Releases

`ft release patch|minor|major` releases from the default branch. It first pushes any commits origin lacks and waits for their runs, so failing tests stop it before a tag exists that would never publish; a push starting no run within 3 minutes lets it go on. A refused push drops the bump commit and tag. A repo with its own bump script runs it, then `ft release --tagged`. In a monorepo, `ft release patch -p ft` bumps `packages/ft` alone, refreshes `bun.lock`, and commits and tags it `ft-v<version>`, so each package releases on its own. `--dry-run` makes the same checks, then prints the bump (`1.0.0 -> 1.1.0`), the tag, whether HEAD is pushed first, the pushes and the runs and registry it would wait for, and changes nothing. Once released, an open milestone titled like the version (`1.2.0`, `v1.2.0` or the tag) has its closed issues listed and is closed; a failure there only warns.

## Issue claims

Sessions claim an issue with a `Taken by session <name>.` comment and give it back with `Released by session <name>.`. `ft board` checks each claim against the Claude Code sessions running on this machine (`~/.claude/sessions` and `~/.claude-accounts/*/sessions`, pid and start time). A lane's claim (`lane-<n>-<issue>`) is held while the session named `*-<n>` runs: `ft take 12 13 --lane` from session `kayjs-60` claims them as `lane-60-12` and `lane-60-13`, and a session can pass its own claim to one of its lanes. A claim no session here answers to may come from another machine, so `ft take` only takes it over with `--take-stale`.
