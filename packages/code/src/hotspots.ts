#!/usr/bin/env bun

import type { Hotspot } from './churn'
import { join } from 'node:path'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, runMain, table } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { churnSince, complexityOf, isCandidate, isGenerated } from './churn'
import { listFiles, readText } from './files'

const DEFAULT_SINCE = '6 months ago'
const DEFAULT_COUNT = 20

const USAGE = `hotspots [options] [dir]: ranks the source files under dir (here by default) by complexity times churn, the ones both hard to read and often edited first, honouring .gitignore

Complexity is the count of decision points in the file (branches, loops, cases, catches, boolean operators, ternaries) plus one, churn the commits touching it since --since (${DEFAULT_SINCE}), score their product. Test files and generated or built files are left out unless --all.

Exits 0 when it ranked the files, 1 when no file has commits in the window or the folder is no git repository, 2 on a usage error.`

const OPTIONS = {
  since: { type: 'string', short: 's', description: `only count the commits since this date, as git reads it (${DEFAULT_SINCE})` },
  count: { type: 'string', short: 'n', description: `files to list (${DEFAULT_COUNT}), 0 for all` },
  all: { type: 'boolean', short: 'a', description: 'keep test files and generated files' },
  json: jsonOption('[{rank, path, score, churn, complexity, lines}]'),
} as const

function limit(text: string | undefined): number {
  if (text === undefined)
    return DEFAULT_COUNT

  const count = Number(text)

  if (!Number.isInteger(count) || count < 0)
    badUsage(`-n takes a whole number, got ${text}`)

  return count
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[dir]'], examples: ['hotspots', 'hotspots src --since "3 months ago" -n 10'] })

  if (positionals.length > 1)
    badUsage('give one folder')

  const count = limit(values.count)
  const cwd = process.cwd()
  const churn = await churnSince(cwd, values.since ?? DEFAULT_SINCE)

  if (churn === undefined)
    fail('not a git repository, churn comes from its log', 1)

  const ranked: Hotspot[] = []

  for (const path of await listFiles(positionals[0] === undefined ? [] : [positionals[0]], cwd)) {
    const touched = churn.get(path)

    if (touched === undefined || (values.all !== true && !isCandidate(path)))
      continue

    const text = await readText(join(cwd, path))

    if (text === undefined || (values.all !== true && isGenerated(text)))
      continue

    const complexity = complexityOf(text)

    ranked.push({ path, score: complexity * touched, churn: touched, complexity, lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) })
  }

  if (ranked.length === 0)
    fail('no file with commits in that window', 1)

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  const shown = ranked.slice(0, count === 0 ? undefined : count).map((hotspot, index) => ({ rank: index + 1, ...hotspot }))

  if (values.json === true)
    printJson(shown)
  else
    console.log(table([['rank', 'score', 'churn', 'complexity', 'lines', 'file'], ...shown.map(row => [row.rank, row.score, row.churn, row.complexity, row.lines, row.path].map(String))], { header: true, align: ['right', 'right', 'right', 'right', 'right', 'left'] }))

  return 0
}

process.exitCode = await runMain({ name: 'hotspots', version, run: main })
