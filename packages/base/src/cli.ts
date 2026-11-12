#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { base } from './base'
import { proof } from './proof'

process.exitCode = await runCli({
  name: 'base',
  about: 'runs a command at HEAD or another ref in a temporary worktree, sharing node_modules and env files with the working tree unless --no-link',
  replaces: 'git stash, a test run, then git stash pop',
  examples: [['base -- bun test tests/api.test.ts', 'the test at HEAD, the working tree changes left out'], ['base proof -- bun test tests/new.test.ts', 'it fails at HEAD and passes in the working tree']],
  commands: {
    run: { summary: 'the command at HEAD or --ref, exiting with its code (the command when none is named)', run: base },
    proof: { summary: 'the command at HEAD or --ref, then in the working tree: proves a test fails before a change and passes after it', run: proof },
  },
  defaultCommand: 'run',
})
