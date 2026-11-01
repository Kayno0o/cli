#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'

process.exitCode = await runCli({
  name: 'pkg',
  version,
  about: 'checks npm packages before they are added, and moves a lib\'s consumers onto a new release',
  defaultCommand: 'check',
  commands: {
    check: { summary: 'check packages before they are added (`pkg <name>` alone runs it)', run: async args => (await import('./commands/check')).check(args) },
    bump: { summary: 'wait for a release on the registry, then bun add it in every consumer', run: async args => (await import('./commands/bump')).bump(args) },
    consumers: { summary: 'list the folders depending on a package, with the version each asks for', run: async args => (await import('./commands/consumers')).consumers(args) },
  },
})
