import type { ExitRow } from '@kaynooo/cli-kit'
import { basename } from 'node:path'
import process from 'node:process'
import { badUsage, capped, configuredNumber, fail, jsonOption, limitOf, limitOptions, parse, printHeader, printJson, readUserConfig, role, runCommand, table, wholeNumber } from '@kaynooo/cli-kit'
import { isCandidate } from './churn'
import { listFiles } from './files'

const SETTINGS = readUserConfig('hotspots')
const DEFAULT_SINCE = typeof SETTINGS.since === 'string' && SETTINGS.since !== '' ? SETTINGS.since : '6 months ago'
const DEFAULT_BULK = configuredNumber('hotspots', 'bulk', 25)
const DEFAULT_LIMIT = 20

const USAGE = `src coupling [options] [dir]: lists pairs of files that frequently change together in git history

Finds temporal coupling (co-change pairs) under dir (here by default). Commits touching more files than --bulk are ignored as sweeps. Coupling percentage is co-changes divided by the smaller of the two files' commit counts.`
const EXITS: ExitRow[] = [[0, 'it listed the coupled pairs'], [1, 'no pair met the minimum co-change count'], [2, 'a usage error or outside a git repository']]

const OPTIONS = {
  since: { type: 'string', short: 's', description: `only count commits since this date (${DEFAULT_SINCE})` },
  bulk: { type: 'string', description: `ignore commits touching more files than this (${DEFAULT_BULK})` },
  min: { type: 'string', short: 'm', description: 'minimum co-changes for a pair to be shown (2)' },
  all: { type: 'boolean', short: 'a', description: 'include test and generated files' },
  ...limitOptions(DEFAULT_LIMIT),
  json: jsonOption('[{a, b, coChanges, commitsA, commitsB, coupling}]'),
} as const

export interface CoupledPair {
  a: string
  b: string
  coChanges: number
  commitsA: number
  commitsB: number
  coupling: number
}

export async function couplingSince(cwd: string, since: string, options: { bulk: number, min: number, all: boolean, dir?: string }): Promise<CoupledPair[] | undefined> {
  const [logRan, topRan] = await Promise.all([
    runCommand(['git', 'log', `--since=${since}`, '--no-renames', '--name-only', '--format=%x01', '-z'], { cwd }),
    runCommand(['git', 'rev-parse', '--show-prefix'], { cwd }),
  ])

  if (logRan.code !== 0 || topRan.code !== 0)
    return undefined

  const prefix = topRan.text.trim()
  const existing = new Set((await listFiles(options.dir === undefined ? [] : [options.dir], cwd)).filter(file => options.all || isCandidate(file)))
  const commits = new Map<string, number>()
  const pairs = new Map<string, number>()

  for (const chunk of logRan.text.split('\x01').slice(1)) {
    const raw = [...new Set(chunk.split('\0').map(item => item.trim()).filter(Boolean))]

    if (raw.length > options.bulk || raw.length < 2)
      continue

    const files = raw
      .filter(file => file.startsWith(prefix))
      .map(file => file.slice(prefix.length))
      .filter(file => existing.has(file))
      .sort()

    for (const file of files)
      commits.set(file, (commits.get(file) ?? 0) + 1)

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`

        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
  }

  const ranked: CoupledPair[] = []

  for (const [key, coChanges] of pairs) {
    if (coChanges < options.min)
      continue

    const [a = '', b = ''] = key.split('\0')
    const commitsA = commits.get(a) ?? coChanges
    const commitsB = commits.get(b) ?? coChanges
    const coupling = Math.round((coChanges / Math.min(commitsA, commitsB)) * 100) / 100

    ranked.push({ a, b, coChanges, commitsA, commitsB, coupling })
  }

  ranked.sort((x, y) => y.coChanges - x.coChanges || y.coupling - x.coupling || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))

  return ranked
}

export async function coupling(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['[dir]'], examples: [['src coupling', 'files that change together'], ['src coupling packages/kit --min 3', 'strongly coupled pairs in packages/kit']] })

  if (positionals.length > 1)
    badUsage('give at most one folder')

  const bulk = wholeNumber(values.bulk, 'bulk', DEFAULT_BULK, 2)
  const min = wholeNumber(values.min, 'min', 2, 1)
  const limit = limitOf(values, DEFAULT_LIMIT)
  const cwd = process.cwd()
  const ranked = await couplingSince(cwd, values.since ?? DEFAULT_SINCE, { bulk, min, all: values.all === true, ...(positionals[0] === undefined ? {} : { dir: positionals[0] }) })

  if (ranked === undefined)
    fail('not a git repository, coupling comes from its log')

  if (ranked.length === 0)
    fail(`no file pair changed together at least ${min} times in that window`, 1)

  const { shown, footer } = capped(ranked, limit)

  if (values.json === true) {
    printJson(shown)

    return 0
  }

  const p = role('path', process.stdout)

  printHeader('coupling', `${basename(cwd)} · since ${values.since ?? DEFAULT_SINCE}`)
  console.log(table([['co', 'coupling', 'file a', 'file b'], ...shown.map(row => [String(row.coChanges), `${Math.round(row.coupling * 100)}%`, p(row.a), p(row.b)])], { header: true, align: ['right', 'right', 'left', 'left'] }))

  if (footer !== undefined)
    console.log(footer)

  return 0
}
