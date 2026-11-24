import type { ManPage, OptionDoc } from './man'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import process from 'node:process'
import { stripAnsi } from '@kaynooo/cli-kit'
import { parsePage } from './man'

const SAFE_NAME = /^[\w.+-]+$/
const TIMEOUT_MS = 3000
const MAX_BYTES = 512 * 1024
const MAX_SUMMARY = 100
const USAGE_LINE = /^usage/i
const HEADER_LINE = /:$/
const VERSION_BANNER = /^\S+(?:\s+[-–]|\s+version)?\s+v?\d+(?:\.\d+)+\b/i

interface KitHelpJson {
  synopsis?: string
  summary?: string
  about?: string
  options?: { name: string, short?: string, type?: 'boolean' | 'string', description?: string }[]
}

// Reads `@kaynooo/cli-*` JSON help emitted under `KIT_HELP=json` into a ManPage directly.
export function parseKitHelpJson(name: string, raw: string): ManPage | undefined {
  const trimmed = raw.trim()

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}'))
    return undefined

  try {
    const data = JSON.parse(trimmed) as KitHelpJson

    if (typeof data !== 'object' || data === null || (data.synopsis === undefined && data.about === undefined && !Array.isArray(data.options)))
      return undefined

    const options: OptionDoc[] = (data.options ?? []).map((opt) => {
      const flags = [...opt.short === undefined ? [] : [`-${opt.short}`], `--${opt.name}`]
      const argument = opt.type === 'string' ? opt.name.toUpperCase() : undefined

      return { flags, argument, optional: false, text: opt.description ?? '' }
    })

    return { name, summary: data.summary ?? data.about, options }
  }
  catch {
    return undefined
  }
}

// The first sentence at the margin above the options, past the usage lines and a `name - 1.2.3` banner: GNU puts it right under the usage line, others under the banner.
function summaryOf(text: string): string | undefined {
  const candidates: string[] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (trimmed.startsWith('-') || (HEADER_LINE.test(trimmed) && !USAGE_LINE.test(trimmed)))
      break

    if (VERSION_BANNER.test(trimmed))
      candidates.length = 0
    else if (trimmed !== '' && line === trimmed && !USAGE_LINE.test(trimmed))
      candidates.push(trimmed)
  }

  const [first] = candidates

  return first === undefined || first.length > MAX_SUMMARY ? undefined : first
}

// The program to run for `name`: a bare name found on PATH, or an absolute path that is that same program, never a script elsewhere.
function programOf(name: string, env: Record<string, string | undefined>): string | undefined {
  const bare = name.startsWith('/') ? basename(name) : name

  if (!SAFE_NAME.test(bare))
    return undefined

  const path = Bun.which(bare, { PATH: env.PATH ?? '' })

  if (path === null || bare === name)
    return path ?? undefined

  try {
    return realpathSync(name) === realpathSync(path) ? path : undefined
  }
  catch {
    return undefined
  }
}

function helpOf(path: string, args: string[], env: Record<string, string | undefined>): { stdout: string, combined: string } | undefined {
  const result = Bun.spawnSync([path, ...args, '--help'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BYTES,
    cwd: tmpdir(),
    env: { ...env, NO_COLOR: '1', TERM: 'dumb', KIT_HELP: 'json' },
  })

  const stdout = stripAnsi(result.stdout.toString())
  const combined = stripAnsi(`${result.stdout.toString()}\n${result.stderr.toString()}`)

  return combined.trim() === '' ? undefined : { stdout, combined }
}

// Runs `<name> [subcommand] --help` (with KIT_HELP=json for @kaynooo/cli tools) and reads its option list like a man page. Only a program on PATH is run, never a script in the current folder, with no stdin and a timeout.
export function loadHelp(name: string, subcommand: string | undefined, env: Record<string, string | undefined> = process.env): ManPage | undefined {
  const path = programOf(name, env)

  if (path === undefined)
    return undefined

  const attempts = subcommand !== undefined && SAFE_NAME.test(subcommand) && !subcommand.startsWith('-') ? [[subcommand], []] : [[]]

  for (const args of attempts) {
    const out = helpOf(path, args, env)

    if (out === undefined)
      continue

    const title = [name, ...args].join(' ')
    const kitPage = parseKitHelpJson(title, out.stdout)

    if (kitPage !== undefined && (kitPage.options.length > 0 || kitPage.summary !== undefined))
      return kitPage

    const page = parsePage(title, out.combined)

    if (page.options.length > 0)
      return { ...page, summary: summaryOf(out.combined) }
  }

  return undefined
}
