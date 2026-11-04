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
| `gl ci [ref]` | waits for the pipeline covering a commit on the default branch and prints each failed job's excerpt; `--sha <ref>` gives the commit as an option, `-j <job>` names a job whose skipping leaves the work to the next commit's pipeline, `--json` prints `{status, runs, failedJobs, url}`, `--quiet` only the announcement, the failures and the result |
| `gl retry [pipeline]` | retries the failed jobs of a pipeline; `-j <name or id>` retries one job of it, or a job id alone when no pipeline is given; `--json` prints the pipeline as `{id, number, status, ref, sha, url}` or the job as `{id, name, stage, status, url}` |
| `gl logs <pipeline>` | what the failed jobs of a pipeline say went wrong; `-j <name or id>` picks a job, `--full` prints whole traces, `--json` the pipeline, its picked jobs and the failed ones with their excerpts |

## JSON output

`--json` prints the shape `ft` prints: `{status, runs, failedJobs, url}`, `status` being the pipeline's with GitLab's `failed` renamed `failure` and `canceled` renamed `cancelled` (the others, such as `running`, `pending` and `manual`, are kept).
A `runs` item is `{id, number, status, ref, sha, url}` and a `failedJobs` item `{name, stage, reason, url, excerpt}`; `gl logs --json` adds `jobs`, one `{name, id, stage, status, allowFailure, url, excerpt}` per picked job.

## Behaviour

- `gl ci` follows the commit's newest pipeline on the branch (`-b`, by default the one `origin/HEAD` names). GitLab runs a push's pipeline on its last commit only and cancels a redundant one, so a commit without a pipeline of its own, or whose own was cancelled or skipped, is covered by the next first-parent commit's.
- Exit codes of `gl ci`: 0 passed (or stopped at a manual job, its earlier stages passed), 1 failed, 2 could not check. An exit 2 says which on the first line of its message: `timeout` (`-t`, 30m by default, a bare number in minutes), `no pipeline` after 3 minutes, `no runner` when jobs wait for 10 minutes while none runs, or `not on branch`.
- A tag's pipeline runs on the tag's ref: `gl ci <tag>` follows that tag's pipeline alone, and `gl ci <sha>` looks at the branch's pipeline first, then at those of the tags pointing at the commit. A tagged commit that is not on the branch is not refused, its tag pipeline being what is waited on.
- A failed job's excerpt is each failed PHPUnit or paratest test (ten at most, fifteen lines each, dependency frames left out) and the verdict, else the last 40 lines of the script section that failed; the runner's `ERROR: Job failed` line closes it. Jobs allowed to fail are left out unless `-j` names them.
- Traces are shown as a terminal would: timestamps, colours, section markers and lines a carriage return overwrote are dropped.
- `gl retry` is the only command that writes: it retries, and never cancels or plays a job.
