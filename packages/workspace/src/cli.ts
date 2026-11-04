#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { audit } from './audit'
import { repos } from './repos'
import { sweep } from './sweep'

process.exitCode = await runCli({
  name: 'ws',
  about: 'the repositories under a root: the ones needing attention, the folders worth reclaiming and their known vulnerabilities',
  replaces: 'a cd, git status and du loop over each repository of the workspace, and a bun audit run in each',
  examples: ['ws repos', ['ws sweep --older 30d', 'what a month of idle repos weighs'], 'ws audit'],
  commands: {
    repos: { summary: 'the git repositories that need attention: dirty, ahead or behind, worktrees, unreleased commits', run: repos },
    sweep: { summary: 'the regenerable folders, caches and clean worktrees, largest first, deleted only on --apply', run: sweep },
    audit: { summary: 'the known vulnerabilities of the Bun repositories, one table per repository', run: audit },
  },
})
