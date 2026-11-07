import type { ManPage } from './man'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { stripAnsi } from '@kaynooo/cli-kit'
import { parsePage } from './man'

const SAFE_NAME = /^[\w.+-]+$/
const TIMEOUT_MS = 3000
const MAX_BYTES = 512 * 1024
const MAX_SUMMARY = 100
const USAGE_LINE = /^usage/i

function summaryOf(text: string): string | undefined {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '')

  return first === undefined || first.length > MAX_SUMMARY || USAGE_LINE.test(first) || first.startsWith('-') ? undefined : first
}

function helpOf(path: string, args: string[], env: Record<string, string | undefined>): string | undefined {
  const result = Bun.spawnSync([path, ...args, '--help'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BYTES,
    cwd: tmpdir(),
    env: { ...env, NO_COLOR: '1', TERM: 'dumb' },
  })

  const text = stripAnsi(`${result.stdout.toString()}\n${result.stderr.toString()}`)

  return text.trim() === '' ? undefined : text
}

// Runs `<name> [subcommand] --help` and reads its option list like a man page. Only a bare name found on PATH is run, never a path or a script in the current folder, with no stdin and a timeout.
export function loadHelp(name: string, subcommand: string | undefined, env: Record<string, string | undefined> = process.env): ManPage | undefined {
  if (!SAFE_NAME.test(name))
    return undefined

  const path = Bun.which(name, { PATH: env.PATH ?? '' })

  if (path === null)
    return undefined

  const attempts = subcommand !== undefined && SAFE_NAME.test(subcommand) && !subcommand.startsWith('-') ? [[subcommand], []] : [[]]

  for (const args of attempts) {
    const text = helpOf(path, args, env)

    if (text === undefined)
      continue

    const page = parsePage([name, ...args].join(' '), text)

    if (page.options.length > 0)
      return { ...page, summary: summaryOf(text) }
  }

  return undefined
}
