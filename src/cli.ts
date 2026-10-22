#!/usr/bin/env bun

import process from 'node:process'
import { version } from '../package.json'
import { Exit } from './args'
import { board, drop, take } from './commands/board'
import { ci } from './commands/ci'
import { fixed, issue, tick } from './commands/issue'
import { logs } from './commands/logs'
import { release } from './commands/release'
import { remote } from './commands/remote'
import { runs } from './commands/runs'
import { watch } from './commands/watch'

type Command = (args: string[]) => Promise<number>

const COMMANDS: Record<string, { run: Command, summary: string }> = {
  runs: { run: runs, summary: 'recent runs with workflow, ref, duration and age' },
  ci: { run: ci, summary: 'wait for the runs covering a commit, printing what failed' },
  watch: { run: watch, summary: 'wait for runs newer than an id, or those in progress' },
  logs: { run: logs, summary: 'what the failed jobs of a run say went wrong' },
  release: { run: release, summary: 'bump, push branch and tag atomically, wait for runs and registry' },
  board: { run: board, summary: 'open issues: available, taken by a live session, or claimed by one gone' },
  take: { run: take, summary: 'claim an issue for this Claude Code session' },
  drop: { run: drop, summary: 'give back an issue this session took' },
  issue: { run: issue, summary: 'an issue\'s claim and checklist boxes, numbered' },
  tick: { run: tick, summary: 'tick checklist boxes of an issue' },
  fixed: { run: fixed, summary: 'comment "Fixed in <sha>" and close an issue' },
  remote: { run: remote, summary: 'check or fix an origin using an ssh alias tea cannot match' },
}

function help(): string {
  const width = Math.max(...Object.keys(COMMANDS).map(name => name.length))

  return [
    `ft ${version}: Forgejo tools over tea, run from a repository whose origin is on Forgejo`,
    '',
    'usage: ft <command> [options], ft <command> --help for its options',
    '',
    ...Object.entries(COMMANDS).map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`),
  ].join('\n')
}

const [name, ...args] = process.argv.slice(2)

if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
  console.log(help())
  process.exit(0)
}

if (name === '--version' || name === '-v') {
  console.log(version)
  process.exit(0)
}

const command = COMMANDS[name]

if (command === undefined) {
  console.error(`ft: no command ${name}\n\n${help()}`)
  process.exit(2)
}

try {
  process.exitCode = await command.run(args)
}
catch (error) {
  if (error instanceof Exit) {
    console.error(`ft ${name}: ${error.message}`)
    process.exitCode = error.code
  }
  else {
    console.error(`ft ${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
