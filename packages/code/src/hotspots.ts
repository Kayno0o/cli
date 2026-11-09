import type { ExitRow } from '@kaynooo/cli-kit'
import type { Hotspot } from './churn'
import { basename, join } from 'node:path'
import process from 'node:process'
import { badUsage, capped, configuredNumber, duration, fail, fileLink, jsonOption, limitOf, limitOptions, paint, parse, printHeader, printJson, readUserConfig, role, table } from '@kaynooo/cli-kit'
import { churnSince, complexityOf, isCandidate, isGenerated } from './churn'
import { listFiles, readText } from './files'
import { worstUnit } from './units'

const SETTINGS = readUserConfig('hotspots')
const DEFAULT_SINCE = typeof SETTINGS.since === 'string' && SETTINGS.since !== '' ? SETTINGS.since : '6 months ago'
const DEFAULT_BULK = configuredNumber('hotspots', 'bulk', 25)
const DAY_MS = 86_400_000
const DEFAULT_HALF_LIFE = '90d'
const DEFAULT_COUNT = configuredNumber('hotspots', 'limit', 20)

const USAGE = `hotspots [options] [dir]: ranks the source files under dir (here by default) by complexity times churn, the ones both hard to read and often edited first, honouring .gitignore

Complexity is the count of decision points in the file (branches, loops, cases, catches, boolean operators, ternaries) plus one, churn the commits touching it since --since (${DEFAULT_SINCE}), score their product. A commit counts for less the older it is (half as much every --half-life, 0 for all alike) and a commit touching more than --bulk files, a format or rename sweep, is left out. --by-lines scores the lines changed instead of the commits. Each file also shows how many lines changed, its author count ("solo" when one author wrote every change) and its most complex declaration, found by indentation. Test files and generated or built files are left out unless --all.

Lists at most ${DEFAULT_COUNT} files, the count of the rest after them (--limit <n>, --full for all); --json is never cut unless --limit is given.`
const EXITS: ExitRow[] = [[0, 'it ranked the files'], [1, 'no file has commits in the window'], [2, 'a usage error or outside a git repository']]

const OPTIONS = {
  'since': { type: 'string', short: 's', description: `only count the commits since this date, as git reads it (${DEFAULT_SINCE})` },
  'half-life': { type: 'string', description: `how long until a commit counts half as much (${DEFAULT_HALF_LIFE}), 0 for no decay` },
  'bulk': { type: 'string', description: `leave out the commits touching more files than this (${DEFAULT_BULK})` },
  ...limitOptions(DEFAULT_COUNT),
  'all': { type: 'boolean', short: 'a', description: 'keep test files and generated files' },
  'by-lines': { type: 'boolean', description: 'score complexity times the lines changed (decayed like the commits) instead of the commits' },
  'json': jsonOption('[{rank, path, score, churn, recent, changed, authors, solo, complexity, worst, lines}], never cut unless --limit is given; changed counts the lines added and deleted, solo being true for a file one author edited'),
} as const

const HOT = 0.66
const WARM = 0.33

export async function hotspots(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['[dir]'], replaces: 'guessing which files are worth splitting first', examples: ['hotspots', 'hotspots src --since "3 months ago" --limit 10'] })

  if (positionals.length > 1)
    badUsage('give one folder')

  const count = limitOf(values, DEFAULT_COUNT)
  const cwd = process.cwd()
  const bulk = Number(values.bulk ?? DEFAULT_BULK)

  if (!Number.isInteger(bulk) || bulk < 1)
    badUsage(`--bulk takes a number of files, not ${values.bulk}`)

  const halfLifeMs = values['half-life'] === '0' ? 0 : duration(values['half-life'], 'half-life', 90 * DAY_MS)
  const churn = await churnSince(cwd, values.since ?? DEFAULT_SINCE, { bulk, halfLifeMs })

  if (churn === undefined)
    fail('not a git repository, churn comes from its log')

  const ranked: Hotspot[] = []

  for (const path of await listFiles(positionals[0] === undefined ? [] : [positionals[0]], cwd)) {
    const touched = churn.get(path)

    if (touched === undefined || (values.all !== true && !isCandidate(path)))
      continue

    const text = await readText(join(cwd, path))

    if (text === undefined || (values.all !== true && isGenerated(text)))
      continue

    const complexity = complexityOf(text)

    const worst = worstUnit(text, path)

    ranked.push({ path, score: Math.round(complexity * (values['by-lines'] === true ? touched.linesWeight : touched.weight)), churn: touched.commits, recent: Math.round(touched.weight * 10) / 10, changed: touched.lines, authors: touched.authors, solo: touched.authors === 1, complexity, worst: worst === undefined ? undefined : { name: worst.name, line: worst.line, complexity: worst.complexity }, lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) })
  }

  if (ranked.length === 0)
    fail('no file with commits in that window', 1)

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  const { shown: kept, footer } = capped(ranked, count)
  const shown = kept.map((hotspot, index) => ({ rank: index + 1, ...hotspot }))

  if (values.json === true) {
    printJson(shown)

    return 0
  }

  const colors = paint(process.stdout)
  const path = role('path', process.stdout)
  const top = shown.reduce((highest, row) => Math.max(highest, row.score), 0)
  // The score reddens with its share of the highest, so the files to split first stand out.
  const heat = (score: number, text: string) => {
    if (top > 0 && score >= top * HOT)
      return colors.red(text)

    return top > 0 && score >= top * WARM ? colors.yellow(text) : text
  }

  printHeader('hotspots', `${basename(cwd)} · since ${values.since ?? DEFAULT_SINCE}`)
  console.log(table([['rank', 'score', 'churn', 'recent', 'changed', 'authors', 'complexity', 'lines', 'file', 'most complex declaration'], ...shown.map(row => [colors.dim(String(row.rank)), heat(row.score, String(row.score)), ...[row.churn, row.recent, row.changed].map(String), row.solo ? colors.dim('1 solo') : String(row.authors), ...[row.complexity, row.lines].map(String), fileLink(path(row.path), row.path, process.stdout, cwd), row.worst === undefined ? '' : `${row.worst.name} (${row.worst.complexity}, line ${row.worst.line})`])], { header: true, align: ['right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left'] }))

  if (footer !== undefined)
    console.log(footer)

  return 0
}
