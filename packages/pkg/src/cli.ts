#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'

process.exitCode = await runCli({
  name: 'pkg',
  about: 'checks, adds, audits and updates packages safely across bun, pnpm, yarn, npm, composer, cargo and uv',
  replaces: 'bun add on trust, and a bun info and sleep loop then a bun add per consumer',
  examples: [['pkg zod', 'the name, the newest version two weeks old, its licence and scripts'], ['pkg add zod', 'vet and install exact safe version with the detected manager'], ['pkg update --apply', 'update dependencies safely across workspaces']],
  defaultCommand: 'check',
  commands: {
    check: { summary: 'check packages before they are added (`pkg <name>` alone runs it)', run: async args => (await import('./commands/check')).check(args) },
    add: { summary: 'vet packages and install exact safe versions with the detected package manager', run: async args => (await import('./commands/add')).add(args) },
    audit: { summary: 'vet lockfiles (bun, pnpm, yarn, npm, composer, cargo, uv) with advisories and direct/via chains', run: async args => (await import('./commands/audit')).audit(args) },
    update: { summary: 'list or --apply safe updates across the folder and its workspaces', run: async args => (await import('./commands/outdated')).outdatedCommand(args) },
    outdated: { summary: 'list dependencies that have a newer version safe to take (alias of update)', run: async args => (await import('./commands/outdated')).outdatedCommand(args) },
    bump: { summary: 'wait for a release on the registry, then add it in every bun/pnpm/yarn/npm consumer', run: async args => (await import('./commands/bump')).bump(args) },
    consumers: { summary: 'list the folders depending on a package, with the version each asks for', run: async args => (await import('./commands/consumers')).consumers(args) },
    manager: { summary: 'the command this folder\'s package manager runs to install, remove, update or exec', run: async args => (await import('./commands/manager')).manager(args) },
  },
})
