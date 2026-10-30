#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { ci } from './commands/ci'
import { logs } from './commands/logs'
import { runs } from './commands/runs'

process.exitCode = await runCli({
  name: 'gl',
  version,
  about: 'GitLab pipelines over glab, run from a repository whose remote is on GitLab',
  commands: {
    runs: { run: runs, summary: 'recent pipelines with ref, source, commit, duration and age' },
    ci: { run: ci, summary: 'wait for the pipeline covering a commit, printing what failed' },
    logs: { run: logs, summary: 'what the failed jobs of a pipeline say went wrong' },
  },
})
