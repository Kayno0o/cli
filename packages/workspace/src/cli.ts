#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { audit } from './audit'
import { exec, pull, push } from './ops'
import { repos } from './repos'
import { sweep } from './sweep'

process.exitCode = await runCli({
  name: 'ws',
  about: 'multi-repo workspace manager: repos status, pull, push, exec, disk sweep, and multi-ecosystem audit',
  replaces: 'shell loops over workspace repositories for git status/pull/push, du/rm cleanup, and multi-ecosystem audit',
  examples: ['ws repos', 'ws pull --prune', 'ws exec -- git status -s', 'ws audit'],
  commands: {
    repos: { summary: 'git repositories needing attention: dirty, ahead/behind, worktrees, unreleased commits', run: repos },
    pull: { summary: 'fetch (--prune) and fast-forward behind repositories (--dirty safely stashes/pops)', run: pull },
    push: { summary: 'push ahead repositories that are not diverged', run: push },
    exec: { summary: 'run a command across workspace repositories (`ws exec [root] -- <cmd...>`)', run: exec },
    sweep: { summary: 'regenerable folders, caches and clean worktrees, largest first, deleted only on --apply', run: sweep },
    audit: { summary: 'known vulnerabilities across Bun, pnpm, Yarn, npm, Composer, Cargo and uv lockfiles', run: audit },
  },
})
