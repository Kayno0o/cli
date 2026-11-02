#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { audit } from './commands/audit'
import { diff, missing } from './commands/compare'
import { cp, mv, set, unset } from './commands/edit'
import { get, grep, list, show } from './commands/read'

process.exitCode = await runCli({
  name: 'ev',
  version,
  about: '.env files listed and edited with secrets masked',
  replaces: 'cat .env, grep on env files and editing them by hand',
  examples: ['ev list', ['ev get DATABASE_URL', 'one key, its value masked']],
  commands: {
    list: { run: list, summary: 'every key of the .env* files, secrets masked' },
    get: { run: get, summary: 'one key\'s masked value' },
    grep: { run: grep, summary: 'the keys matching a regex, values masked' },
    show: { run: show, summary: 'an env file at a git revision, values masked' },
    set: { run: set, summary: 'set a key, the value read from stdin or -F' },
    unset: { run: unset, summary: 'remove a key from a file' },
    cp: { run: cp, summary: 'copy a key from one file to another, the value never printed' },
    mv: { run: mv, summary: 'move a key from one file to another' },
    diff: { run: diff, summary: 'keys set in one file and not the other' },
    missing: { run: missing, summary: 'keys of .env.example that .env lacks' },
    audit: { run: audit, summary: '.env files others can read or git tracks, compose files writing secrets out' },
  },
  aliases: { ls: 'list' },
})
