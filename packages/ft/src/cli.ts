#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { board, drop, take } from './commands/board'
import { ci } from './commands/ci'
import { commentOn, fixed, issue, tick } from './commands/issue'
import { logs } from './commands/logs'
import { release } from './commands/release'
import { remote } from './commands/remote'
import { runs } from './commands/runs'
import { watch } from './commands/watch'

process.exitCode = await runCli({
  name: 'ft',
  version,
  about: 'Forgejo tools over tea, run from a repository whose origin is on Forgejo',
  commands: {
    runs: { run: runs, summary: 'recent runs with workflow, ref, duration and age' },
    ci: { run: ci, summary: 'wait for the runs covering a commit, printing what failed' },
    watch: { run: watch, summary: 'wait for runs newer than an id, or those in progress' },
    logs: { run: logs, summary: 'what the failed jobs of a run say went wrong' },
    release: { run: release, summary: 'bump, push branch and tag atomically, wait for runs and registry' },
    board: { run: board, summary: 'open issues: available, taken by a live session, or claimed by one gone' },
    take: { run: take, summary: 'claim an issue for this Claude Code session' },
    drop: { run: drop, summary: 'give back an issue this session took' },
    issue: { run: issue, summary: 'an issue\'s claim, description and numbered boxes, -c comments' },
    tick: { run: tick, summary: 'tick checklist boxes of an issue, -m to comment too' },
    comment: { run: commentOn, summary: 'comment on an issue, from stdin when no text is given' },
    fixed: { run: fixed, summary: 'comment "Fixed in <sha>" and close an issue' },
    remote: { run: remote, summary: 'check or fix an origin using an ssh alias tea cannot match' },
  },
  aliases: { show: 'issue', view: 'issue' },
})
