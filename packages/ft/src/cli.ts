#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { board, drop, take } from './commands/board'
import { ci } from './commands/ci'
import { digest } from './commands/digest'
import { dispatch } from './commands/dispatch'
import { commentOn, edit, fixed, issue, newIssue, tick } from './commands/issue'
import { logs } from './commands/logs'
import { milestone, milestones } from './commands/milestone'
import { plan } from './commands/plan'
import { pr } from './commands/pr'
import { release } from './commands/release'
import { play, retry } from './commands/retry'
import { runs } from './commands/runs'
import { closeIssues, label, reopenIssues } from './commands/triage'
import { watch } from './commands/watch'

export async function runForge(): Promise<number> {
  return runCli({
    name: 'ft',
    about: 'unified Forgejo, GitHub and GitLab CLI over direct HTTP — CI runs, logs, PRs/MRs, issues, milestones and releases',
    replaces: 'tea, glab, gh api calls piped through jq, and sleep loops waiting on CI',
    examples: [[`ft ci`, 'wait for the runs of origin\'s tip, failures printed'], [`ft pr list`, 'open pull/merge requests'], [`ft issue 12 -c`, 'an issue with its boxes numbered and its comments']],
    commands: {
      runs: { run: runs, summary: 'recent CI runs/pipelines with workflow, ref, duration and age', group: 'CI and release' },
      ci: { run: ci, summary: 'wait for the runs/pipelines covering a commit, printing what failed', group: 'CI and release' },
      watch: { run: watch, summary: 'wait for runs newer than an id, or those in progress', group: 'CI and release' },
      retry: { run: retry, summary: 'retry failed jobs of a run/pipeline, or one job with -j', group: 'CI and release' },
      play: { run: play, summary: 'start a manual GitLab job by job id or pipeline id + -j', group: 'CI and release' },
      dispatch: { run: dispatch, summary: 'start a workflow_dispatch run or GitLab pipeline, --wait to follow it', group: 'CI and release' },
      logs: { run: logs, summary: 'what the failed jobs of a run/pipeline say went wrong', group: 'CI and release' },
      release: { run: release, summary: 'bump, push branch & tags atomically, wait for CI/registry, publish notes (--notes) or undo', group: 'CI and release' },
      pr: { run: pr, summary: 'pull/merge requests: list, view, create, checkout, merge', group: 'Pull requests' },
      board: { run: board, summary: 'open issues: available, taken by a live session, or claimed by one gone', group: 'Issues and claims' },
      digest: { run: digest, summary: 'repo state for a cold start: held and abandoned claims, red CI, unpushed commits, dirty files, stale TODOs', group: 'Issues and claims' },
      take: { run: take, summary: 'claim an issue for this session (--as <name> or FORGE_SESSION)', group: 'Issues and claims' },
      drop: { run: drop, summary: 'give back an issue this session took', group: 'Issues and claims' },
      issue: { run: issue, summary: 'an issue\'s claim, description and numbered boxes, -c comments', group: 'Issues and claims' },
      new: { run: newIssue, summary: 'create an issue from -t and a description file or stdin', group: 'Issues and claims' },
      edit: { run: edit, summary: 'replace an issue\'s title or description, from a file or stdin', group: 'Issues and claims' },
      tick: { run: tick, summary: 'tick checklist boxes of an issue, -m to comment too', group: 'Issues and claims' },
      comment: { run: commentOn, summary: 'comment on an issue, from stdin when no text is given', group: 'Issues and claims' },
      fixed: { run: fixed, summary: 'comment "Fixed in <sha>" and close an issue', group: 'Issues and claims' },
      close: { run: closeIssues, summary: 'close issues without a fix, -m posting the reason', group: 'Issues and claims' },
      reopen: { run: reopenIssues, summary: 'reopen closed issues, -m posting the reason', group: 'Issues and claims' },
      label: { run: label, summary: 'add +name and remove -name labels of an issue', group: 'Issues and claims' },
      plan: { ...plan, group: 'Repo' },
      milestones: { run: milestones, summary: 'milestones with their open and closed issues, progress and due date', group: 'Repo' },
      milestone: { run: milestone, summary: 'show a milestone\'s issues like the board, `new` creates one, `close` closes it', group: 'Repo' },
    },
    aliases: { show: 'issue', view: 'issue', issues: 'board', mr: 'pr' },
  })
}

if (import.meta.main)
  process.exitCode = await runForge()
