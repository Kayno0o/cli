import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { badUsage, copyText, fail, fileLink, formatAge, formatFileSize, paint, role, table, warn } from '@kaynooo/cli-kit'
import { logDir } from './logs'

export interface SavedLog {
  path: string
  size: number
  mtimeMs: number
}

// The saved logs, the newest first.
export async function savedLogs(): Promise<SavedLog[]> {
  const dir = await logDir()
  const logs: SavedLog[] = []

  for (const name of await readdir(dir)) {
    const path = join(dir, name)

    try {
      const info = await stat(path)

      if (info.isFile() && name.endsWith('.log'))
        logs.push({ path, size: info.size, mtimeMs: info.mtimeMs })
    }
    catch {
      continue
    }
  }

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

export async function printList(): Promise<number> {
  const logs = await savedLogs()

  if (logs.length === 0)
    fail('no saved log', 1)

  const colors = paint(process.stdout)
  const path = role('path', process.stdout)

  console.log(table(logs.map(log => [fileLink(path(log.path), log.path, process.stdout), formatFileSize(log.size), colors.dim(formatAge(log.mtimeMs))])))

  return 0
}

// The lines of a saved log matching the pattern, each with its line number as the folded output refers to it.
export async function grepLog(source: string, name: string | undefined): Promise<number> {
  let pattern: RegExp

  try {
    pattern = new RegExp(source)
  }
  catch (error) {
    return badUsage(`--grep is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const lines = (await Bun.file((await pickLog(name)).path).text()).split('\n')
  const hits = lines.flatMap((line, i) => pattern.test(line) ? [`${i + 1}: ${line}`] : [])

  if (hits.length === 0)
    fail(`no line of the log matches ${source}`, 1)

  console.log(hits.join('\n'))

  return 0
}
