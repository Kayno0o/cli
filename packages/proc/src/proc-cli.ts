#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { pid } from './pid'
import { ports } from './ports'
import { procs } from './procs'

process.exitCode = await runCli({
  name: 'proc',
  about: 'what a process is, who listens on a port and which dev processes are worth cleaning, read from /proc',
  replaces: 'cat /proc/<pid>/..., ss -ltnp, lsof -i and pgrep -f one-liners',
  examples: ['proc pid 1234', 'proc ports', ['proc procs', 'the leftover or heavy processes, dry-run first']],
  commands: {
    pid: { summary: 'what a process is: executable, parents, memory, limits and listening ports', run: pid },
    ports: { summary: 'what listens on this machine, with its owner, and a safe --kill', run: ports },
    procs: { summary: 'the leftover or heavy processes of the calling user, grouped by origin', run: procs },
  },
})
