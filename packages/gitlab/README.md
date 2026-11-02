# gl

GitLab pipelines from the terminal: wait for the one covering a commit, list them, and read what their failed jobs say, where a session would otherwise poll `glab api .../pipelines/<id>/jobs` in a sleep loop and parse it by hand.

```sh
bun install -g @kaynooo/cli-gitlab
gl ci
```

Needs [glab](https://gitlab.com/gitlab-org/cli) logged in (`glab auth login`). Every call goes through `glab api`, so gl has no token of its own: glab owns the login and finds the project from the remote. Run gl from the repository, or pass `--repo group/project` to the commands that take it.

## Commands

| Command | What it does |
| --- | --- |
| `gl runs` | recent pipelines with ref, source, commit, duration, age and the commit's subject when the clone has it (`-n`, `--full`, `--sha`, `-b <ref>`, `--json`) |
| `gl ci [ref]` | waits for the pipeline covering a commit on the default branch and prints each failed job's excerpt |
| `gl logs <pipeline>` | what the failed jobs of a pipeline say went wrong; `-j <name or id>` picks a job, `--full` prints whole traces |

## Behaviour

- `gl ci` follows the commit's newest pipeline on the branch (`-b`, by default the one `origin/HEAD` names). GitLab runs a push's pipeline on its last commit only and cancels a redundant one, so a commit without a pipeline of its own, or whose own was cancelled or skipped, is covered by the next first-parent commit's.
- Exit codes of `gl ci`: 0 passed (or stopped at a manual job, its earlier stages passed), 1 failed, 2 a timeout (`-t`, 30m by default, a bare number in minutes), no pipeline after 3 minutes, jobs waiting on a runner for 10 minutes while none runs, or a commit not on the branch.
- A failed job's excerpt is each failed PHPUnit or paratest test (ten at most, fifteen lines each, dependency frames left out) and the verdict, else the last 40 lines of the script section that failed; the runner's `ERROR: Job failed` line closes it. Jobs allowed to fail are left out unless `-j` names them.
- Traces are shown as a terminal would: timestamps, colours, section markers and lines a carriage return overwrote are dropped.
- Read-only: gl never retries, cancels or plays a job.
