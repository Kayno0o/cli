#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { audit } from './commands/audit'
import { diff, missing } from './commands/compare'
import { mv, set, unset } from './commands/edit'
import { get, list } from './commands/read'

process.exitCode = await runCli({
  name: 'ev',
  version,
  about: '.env files listed and edited with secrets masked',
  commands: {
    list: { run: list, summary: 'every key of the .env* files, secrets masked' },
    get: { run: get, summary: 'one key\'s masked value' },
    set: { run: set, summary: 'set a key, the value read from stdin or -F' },
    unset: { run: unset, summary: 'remove a key from a file' },
    mv: { run: mv, summary: 'move a key from one file to another' },
    diff: { run: diff, summary: 'keys set in one file and not the other' },
    missing: { run: missing, summary: 'keys of .env.example that .env lacks' },
    audit: { run: audit, summary: '.env files others can read or git tracks, compose files writing secrets out' },
  },
  aliases: { ls: 'list' },
})
