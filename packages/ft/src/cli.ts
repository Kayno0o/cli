#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { board, drop, take } from './commands/board'
import { ci } from './commands/ci'
import { digest } from './commands/digest'
import { commentOn, edit, fixed, issue, newIssue, tick } from './commands/issue'
import { logs } from './commands/logs'
import { milestone, milestones } from './commands/milestone'
import { plan } from './commands/plan'
import { release } from './commands/release'
import { remote } from './commands/remote'
import { runs } from './commands/runs'
import { closeIssues, label, reopenIssues } from './commands/triage'
import { watch } from './commands/watch'

process.exitCode = await runCli({
  name: 'ft',
  about: 'Forgejo tools over tea, run from a repository whose origin is on Forgejo',
  replaces: 'tea api calls piped through jq, and sleep loops waiting on CI',
  examples: [['ft ci', 'wait for the runs of origin\'s tip, failures printed'], ['ft issue 12 -c', 'an issue with its boxes numbered and its comments']],
  commands: {
    runs: { run: runs, summary: 'recent runs with workflow, ref, duration and age', group: 'CI and release' },
    ci: { run: ci, summary: 'wait for the runs covering a commit, printing what failed', group: 'CI and release' },
    watch: { run: watch, summary: 'wait for runs newer than an id, or those in progress', group: 'CI and release' },
    logs: { run: logs, summary: 'what the failed jobs of a run say went wrong', group: 'CI and release' },
    release: { run: release, summary: 'bump, push branch and tag atomically, wait for runs and registry', group: 'CI and release' },
    board: { run: board, summary: 'open issues: available, taken by a live session, or claimed by one gone', group: 'Issues and claims' },
    digest: { run: digest, summary: 'repo state for a cold start: held and abandoned claims, red CI, unpushed commits, dirty files, stale TODOs', group: 'Issues and claims' },
    take: { run: take, summary: 'claim an issue for this Claude Code session', group: 'Issues and claims' },
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
    remote: { run: remote, summary: 'check or fix an origin using an ssh alias tea cannot match', group: 'Repo' },
  },
  aliases: { show: 'issue', view: 'issue' },
})
