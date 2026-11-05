#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { audit } from './commands/audit'
import { port } from './commands/port'

process.exitCode = await runCli({
  name: 'stack',
  about: 'a stable port per service name, and a compose release audit',
  replaces: 'picking a free host port by hand, and reading compose files against release.config.ts',
  examples: ['stack port api', ['stack audit', 'this folder\'s release setup']],
  commands: {
    port: { run: port, summary: 'the port a name always hashes to, with a warning when something already listens on it' },
    audit: { run: audit, summary: 'cross-check release.config.ts against its compose files' },
  },
})
