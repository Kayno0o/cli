#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { base } from './base'
import { bisect } from './bisect'
import { proof } from './proof'

process.exitCode = await runCli({
  name: 'base',
  about: 'runs a command at HEAD or another ref in a temporary worktree, sharing node_modules and env files with the working tree unless --no-link',
  replaces: 'git stash, a test run, git bisect, then git stash pop',
  examples: [['base -- bun test tests/api.test.ts', 'the test at HEAD, the working tree changes left out'], ['base proof -- bun test tests/new.test.ts', 'auto-keeps the new test, proves it fails before and passes now'], ['base bisect --good v1.0.0 -- bun test tests/api.test.ts', 'find the first commit that broke a test']],
  commands: {
    run: { summary: 'the command at HEAD or --ref, exiting with its code (the command when none is named)', run: base },
    proof: { summary: 'proves a test fails before a change (HEAD when dirty, else merge-base) and passes now', run: proof },
    bisect: { summary: 'non-destructive binary search for the first commit where a command fails', run: bisect },
  },
  defaultCommand: 'run',
})
