#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { ci } from './commands/ci'
import { logs } from './commands/logs'
import { retry } from './commands/retry'
import { runs } from './commands/runs'

process.exitCode = await runCli({
  name: 'gl',
  about: 'GitLab pipelines over glab, run from a repository whose remote is on GitLab',
  replaces: 'glab ci and glab api .../pipelines/<id>/jobs polled in a sleep loop',
  examples: [['gl ci', 'wait for the pipeline of origin\'s tip, failed tests printed'], ['gl logs 1234 -j test', 'one job\'s failed tests']],
  commands: {
    runs: { run: runs, summary: 'recent pipelines with ref, source, commit, duration and age' },
    ci: { run: ci, summary: 'wait for the pipeline covering a commit, printing what failed' },
    logs: { run: logs, summary: 'what the failed jobs of a pipeline say went wrong' },
    retry: { run: retry, summary: 'retry the failed jobs of a pipeline, or one job' },
  },
})
