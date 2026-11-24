#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { audit } from './commands/audit'
import { diff, missing } from './commands/compare'
import { cp, mv, set, unset } from './commands/edit'
import { check, gen, sync, template } from './commands/manage'
import { get, grep, list, show } from './commands/read'
import { redact } from './commands/redact'
import { run } from './commands/run'

process.exitCode = await runCli({
  name: 'ev',
  about: '.env files listed, run, synced and edited with secrets masked',
  replaces: 'cat .env, grep on env files, sourcing .env into the shell and editing them by hand',
  examples: ['ev list', ['ev run -f .env.test --redact -- bun test', 'run a command with .env.test loaded and output redacted'], ['ev get DATABASE_URL', 'one key, its value masked']],
  commands: {
    list: { run: list, summary: 'every key of the .env* files, secrets masked' },
    get: { run: get, summary: 'one key\'s masked value' },
    grep: { run: grep, summary: 'the keys matching a regex, values masked' },
    show: { run: show, summary: 'an env file at a git revision, values masked' },
    run: { run, summary: 'run a command with .env file(s) loaded, optionally redacting output' },
    set: { run: set, summary: 'set a key, the value read from stdin or -F' },
    unset: { run: unset, summary: 'remove a key from a file' },
    gen: { run: gen, summary: 'generate a random secret directly into a key without printing it' },
    cp: { run: cp, summary: 'copy a key between dotenv or structured files, value never printed' },
    mv: { run: mv, summary: 'move a key between dotenv or structured files' },
    diff: { run: diff, summary: 'keys and values differing between two files or git revisions' },
    missing: { run: missing, summary: 'keys of .env.example that .env lacks' },
    template: { run: template, summary: 'generate or update .env.example with secrets stripped' },
    sync: { run: sync, summary: 'append missing keys from .env.example into .env' },
    check: { run: check, summary: 'lint .env* files for duplicates, quoting hazards, and empty secrets' },
    redact: { run: redact, summary: 'stdin copied to stdout with secrets masked, or --check to list where they are' },
    audit: { run: audit, summary: '.env files others can read or git tracks, compose files writing secrets out' },
  },
  aliases: { ls: 'list' },
})
