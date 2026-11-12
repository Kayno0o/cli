import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { stripAnsi } from '@kaynooo/cli-kit'

export interface OptionDoc {
  flags: string[]
  // The placeholder the option takes (FILE in `--file=FILE`), when it takes one.
  argument: string | undefined
  optional: boolean
  text: string
}

export interface ManPage {
  name: string
  summary: string | undefined
  options: OptionDoc[]
}

const SECTIONS = ['1', '8', '6']
const SAFE_NAME = /^[\w.+-]+$/
const COMPRESSED_UNSUPPORTED = /\.(?:bz2|xz)$/
const WHITESPACE = /\s+/g
const HYPHENATED = /([a-z])- ([a-z])/g
const CURLY_QUOTES = /[‘’]/g
const UNICODE_HYPHENS = /[‐−‑]/g
const NAME_HEADER = /^NAME\s*$/
const NAME_SEPARATOR = / [-‐–] /
const OPTION_BRACKETS = /[[\]<>]/g
const LEADING_EQUALS = /^=/
const ARGUMENT_SPLIT = /,\s+(?=-)/
const FLAG_FORM = /^(--?[\w?@%+][\w.+-]*)(?:(\[=|=|\s)(\S.*))?$/
const HEAD_SPLIT = /\s{2,}/

function manDirs(env: Record<string, string | undefined>): string[] {
  const configured = env.MANPATH?.split(':').filter(dir => dir !== '') ?? []

  return [...configured, '/usr/share/man', '/usr/local/share/man', join(homedir(), '.local/share/man')]
}

// The path of the page for `name`, searching the man path the way man would, minus the translations.
export function findPage(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!SAFE_NAME.test(name))
    return undefined

  for (const section of SECTIONS) {
    for (const dir of manDirs(env)) {
      const folder = join(dir, `man${section}`)

      if (!existsSync(folder))
        continue

      const file = readdirSync(folder).find(entry => entry.startsWith(`${name}.${section}`))

      if (file !== undefined)
        return join(folder, file)
    }
  }

  return undefined
}

function readSource(path: string): Uint8Array | undefined {
  const raw = readFileSync(path)

  if (path.endsWith('.gz'))
    return Bun.gunzipSync(raw)

  if (path.endsWith('.zst'))
    return Bun.zstdDecompressSync(raw)

  return COMPRESSED_UNSUPPORTED.test(path) ? undefined : raw
}

// nroff bolds and underlines by printing a character, a backspace, then the character again.
function unOverstrike(text: string): string {
  const kept: string[] = []

  for (const ch of text) {
    if (ch === '\b')
      kept.pop()
    else
      kept.push(ch)
  }

  return kept.join('')
}

// Without nroff (groff's), a page cannot be read, as on a minimal image.
function render(source: Uint8Array): string | undefined {
  if (Bun.which('nroff') === null)
    return undefined

  const result = Bun.spawnSync(['nroff', '-man', '-Tutf8', '-rLL=200n', '-rLT=200n'], { stdin: source, stdout: 'pipe', stderr: 'ignore', env: { ...process.env, GROFF_NO_SGR: '1' } })

  if (result.exitCode !== 0)
    return undefined

  return stripAnsi(unOverstrike(result.stdout.toString())).replaceAll(UNICODE_HYPHENS, '-')
}

// The page as plain text, or undefined when there is none or nroff cannot render it.
export function pageText(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const path = findPage(name, env)
  const source = path === undefined ? undefined : readSource(path)

  return source === undefined ? undefined : render(source)
}

function parseForm(form: string): { flag: string, argument: string | undefined, optional: boolean } | undefined {
  const match = FLAG_FORM.exec(form.trim())

  if (match === null)
    return undefined

  const [, flag, joiner, value] = match
  const optional = joiner === '[=' || (value?.startsWith('[') ?? false)
  const argument = value?.replaceAll(OPTION_BRACKETS, '').replace(LEADING_EQUALS, '').trim()

  return { flag: flag!, argument: argument === '' ? undefined : argument, optional }
}

// `-e PATTERN, --regexp=PATTERN` as its flags and the placeholder, or undefined when the text is not an option list.
export function parseHead(head: string): Pick<OptionDoc, 'flags' | 'argument' | 'optional'> | undefined {
  const forms = head.split(ARGUMENT_SPLIT).map(parseForm)

  if (forms.length === 0 || forms.includes(undefined))
    return undefined

  const parsed = forms as NonNullable<(typeof forms)[number]>[]

  return { flags: parsed.map(form => form.flag), argument: parsed.find(form => form.argument !== undefined)?.argument, optional: parsed.every(form => form.argument === undefined || form.optional) }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

export function parseOptions(text: string): OptionDoc[] {
  const options: OptionDoc[] = []
  // `inline` marks a help-style entry, whose description follows its flags on the same line.
  let current: { doc: OptionDoc, indent: number, inline: boolean, lines: string[] } | undefined

  const close = (): void => {
    if (current !== undefined) {
      current.doc.text = current.lines.join(' ').replaceAll(WHITESPACE, ' ').replaceAll(HYPHENATED, '$1$2').replaceAll(CURLY_QUOTES, '\'').trim()
      options.push(current.doc)
      current = undefined
    }
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (trimmed === '')
      continue

    const indent = indentOf(line)

    // A help text may start its option lines at the margin; a man page never does.
    if (indent === 0 && !trimmed.startsWith('-')) {
      close()

      continue
    }

    if (trimmed.startsWith('-')) {
      const [head = '', ...rest] = trimmed.split(HEAD_SPLIT)
      const parsed = parseHead(head)
      // In a help text a long-only option is indented past the `-v, ` of the one above it, so a deeper line with its own description still starts an entry.
      const starts = current === undefined || indent <= current.indent || (current.inline && rest.length > 0)

      if (parsed !== undefined && starts) {
        close()
        current = { doc: { ...parsed, text: '' }, indent, inline: rest.length > 0, lines: rest }

        continue
      }
    }

    if (current !== undefined && indent > current.indent)
      current.lines.push(trimmed)
    else
      close()
  }

  close()

  return options
}

function summaryOf(text: string): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex(line => NAME_HEADER.test(line))

  if (start === -1)
    return undefined

  const body: string[] = []

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '')
      break

    body.push(line.trim())
  }

  const joined = body.join(' ')
  const at = joined.search(NAME_SEPARATOR)

  return at === -1 ? undefined : joined.slice(at + 3).trim()
}

export function parsePage(name: string, text: string): ManPage {
  return { name, summary: summaryOf(text), options: parseOptions(text) }
}

export function loadPage(name: string, env: Record<string, string | undefined> = process.env): ManPage | undefined {
  const text = pageText(name, env)

  return text === undefined ? undefined : parsePage(name, text)
}
