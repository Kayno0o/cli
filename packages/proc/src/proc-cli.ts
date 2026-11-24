#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { killCmd, lsCmd, topCmd, treeCmd } from './manage'
import { pid } from './pid'
import { ports } from './ports'
import { cleanup } from './procs'

process.exitCode = await runCli({
  name: 'proc',
  about: 'inspect, search, tree, rank and safely clean processes and listening ports from /proc',
  replaces: 'cat /proc/<pid>/..., ps aux | grep, pstree, ss -ltnp, lsof -i and pkill -f one-liners',
  examples: ['proc pid 1234', 'proc ports', 'proc ls vite', 'proc tree', 'proc top', ['proc cleanup', 'leftover or heavy dev processes, dry-run first']],
  aliases: { find: 'ls', procs: 'cleanup' },
  commands: {
    pid: { summary: 'inspect one process: executable, parents, children, container, memory, limits and ports', run: pid },
    ports: { summary: 'listening ports with owner/container and safe --kill (--docker for containers)', run: ports },
    cleanup: { summary: 'leftover or heavy dev processes grouped by origin (--origin/--tool filters)', run: cleanup },
    ls: { summary: 'list or search processes by pattern (alias: find)', run: lsCmd },
    tree: { summary: 'process hierarchy rooted at a pid or user roots', run: treeCmd },
    top: { summary: 'top processes by memory, open files or age', run: topCmd },
    kill: { summary: 'safely stop one or more processes with protection checks', run: killCmd },
  },
})
