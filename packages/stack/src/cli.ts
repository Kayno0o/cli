#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'

import { port } from './commands/port'

process.exitCode = await runCli({
  name: 'stack',
  about: 'a stable port per service name',
  replaces: 'picking a free host port by hand',
  examples: ['stack port api', ['stack port api --json', 'the port and whether something listens on it']],
  commands: {
    port: { run: port, summary: 'the port a name always hashes to, with a warning when something already listens on it' },
  },
})
