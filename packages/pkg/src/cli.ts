#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'

process.exitCode = await runCli({
  name: 'pkg',
  about: 'checks npm packages before they are added, and moves a lib\'s consumers onto a new release',
  replaces: 'bun add on trust, and a bun info and sleep loop then a bun add per consumer',
  examples: [['pkg zod', 'the name, the newest version two weeks old, its licence and scripts'], ['pkg bump @kaynooo/cli-kit --dry-run', 'the consumers a release would move']],
  defaultCommand: 'check',
  commands: {
    check: { summary: 'check packages before they are added (`pkg <name>` alone runs it)', run: async args => (await import('./commands/check')).check(args) },
    audit: { summary: 'check every package a bun.lock pins, with its known advisories', run: async args => (await import('./commands/audit')).audit(args) },
    outdated: { summary: 'list the dependencies of this folder that have a newer version safe to take', run: async args => (await import('./commands/outdated')).outdatedCommand(args) },
    bump: { summary: 'wait for a release on the registry, then bun add it in every consumer', run: async args => (await import('./commands/bump')).bump(args) },
    consumers: { summary: 'list the folders depending on a package, with the version each asks for', run: async args => (await import('./commands/consumers')).consumers(args) },
  },
})
