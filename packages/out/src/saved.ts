import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { badUsage, copyText, fail, fileLink, formatAge, formatFileSize, paint, printJson, privateLogDirectory, role, table, warn } from '@kaynooo/cli-kit'
import { logDir } from './logs'

export type LogSource = 'out' | 'check' | 'errs'

export interface SavedLog {
  source: LogSource
  path: string
  size: number
  mtimeMs: number
}

const LINE_SPAN = /^(\d+)(?:-(\d+))?$/

async function collectDir(dir: string, source: LogSource, depth: number, logs: SavedLog[]): Promise<void> {
  let names: string[]

  try {
    names = await readdir(dir)
  }
  catch {
    return
  }

  for (const name of names) {
    const path = join(dir, name)

    try {
      const info = await stat(path)

      if (info.isFile() && name.endsWith('.log'))
        logs.push({ source, path, size: info.size, mtimeMs: info.mtimeMs })
      else if (info.isDirectory() && depth > 0)
        await collectDir(path, source, depth - 1, logs)
    }
    catch {
      continue
    }
  }
}

// The saved logs across out, check and errs, the newest first.
export async function savedLogs(): Promise<SavedLog[]> {
  const logs: SavedLog[] = []
  const outPath = await logDir()
  const [checkPath, errsPath] = await Promise.all([privateLogDirectory('check'), privateLogDirectory('errs')])

  await Promise.all([
    collectDir(outPath, 'out', 0, logs),
    collectDir(checkPath, 'check', 1, logs),
    collectDir(errsPath, 'errs', 0, logs),
  ])

  return logs.toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
}

// The log a name or path points at among the saved ones, or the newest; exits 2 when there is none.
export async function pickLog(name: string | undefined): Promise<SavedLog> {
  const logs = await savedLogs()
  const found = name === undefined ? logs[0] : logs.find(log => log.path === name || basename(log.path) === name)

  if (found === undefined)
    fail(name === undefined ? 'no saved log (a run saves one only when its output is folded, and logs older than a day are removed)' : `${name} is not a saved log, \`out --list\` names them`)

  return found
}

export async function printLast(copy = false): Promise<number> {
  const { path } = await pickLog(undefined)

  console.log(path)

  if (copy && !await copyText(path))
    warn('no clipboard tool found (wl-copy, xclip, xsel, pbcopy)')

  return 0
}

export async function printList(json = false): Promise<number> {
  const logs = await savedLogs()

  if (logs.length === 0)
    fail('no saved log', 1)

  if (json) {
    printJson(logs)

    return 0
  }

  const colors = paint(process.stdout)
  const path = role('path', process.stdout)

  console.log(table(logs.map(log => [colors.dim(log.source), fileLink(path(log.path), log.path, process.stdout), formatFileSize(log.size), colors.dim(formatAge(log.mtimeMs))])))

  return 0
}

export interface GrepOptions {
  ignoreCase?: boolean
  context?: number
  json?: boolean
}

// The lines of a saved log matching the pattern, each with its line number as the folded output refers to it.
export async function grepLog(source: string, name: string | undefined, options: GrepOptions = {}): Promise<number> {
  let pattern: RegExp

  try {
    pattern = new RegExp(source, options.ignoreCase === true ? 'i' : '')
  }
  catch (error) {
    return badUsage(`--grep is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const log = await pickLog(name)
  const lines = (await Bun.file(log.path).text()).split('\n')
  const matched = new Set<number>()
  const context = options.context ?? 0

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? ''))
      matched.add(i)
  }

  if (matched.size === 0)
    fail(`no line of the log matches ${source}`, 1)

  const shown = new Set<number>()

  for (const idx of matched) {
    for (let at = Math.max(0, idx - context); at <= Math.min(lines.length - 1, idx + context); at++)
      shown.add(at)
  }

  const indices = [...shown].toSorted((a, b) => a - b)

  if (options.json === true) {
    printJson({ path: log.path, matches: indices.map(i => ({ line: i + 1, matched: matched.has(i), text: lines[i] ?? '' })) })

    return 0
  }

  console.log(indices.map(i => `${i + 1}${matched.has(i) ? ':' : '-'} ${lines[i] ?? ''}`).join('\n'))

  return 0
}

// Prints a 1-indexed line range (`10-40` or `25`) of a saved log.
export async function showLog(span: string, name: string | undefined, json = false): Promise<number> {
  const match = LINE_SPAN.exec(span.trim())

  if (match === null)
    badUsage(`--show takes <line> or <from>-<to>, not ${span}`)

  const from = Number(match[1])
  const to = match[2] === undefined ? from : Number(match[2])

  if (from < 1 || to < from)
    badUsage(`invalid line range ${span}`)

  const log = await pickLog(name)
  const lines = (await Bun.file(log.path).text()).split('\n')

  if (from > lines.length)
    fail(`log has ${lines.length} lines, ${from} is past the end`, 1)

  const end = Math.min(to, lines.length)
  const slice = lines.slice(from - 1, end)

  if (json) {
    printJson({ path: log.path, from, to: end, total: lines.length, lines: slice })

    return 0
  }

  console.log(slice.map((line, i) => `${from + i}: ${line}`).join('\n'))

  return 0
}
