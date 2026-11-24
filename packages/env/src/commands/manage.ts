import type { ExitRow } from '@kaynooo/cli-kit'
import { randomBytes, randomUUID } from 'node:crypto'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, role, wholeNumber } from '@kaynooo/cli-kit'
import { entries, formatAssignment, parseDotenv, serializeDotenv, setLine, unquotable } from '../dotenv'
import { assertDotenvName, envFiles, loadKnown, readEnv, TEMPLATE, withLocks, writeAtomic, writeEnv } from '../files'
import { findSecrets, isSecretKey, maskValue } from '../mask'
import { parseStructured, structuredFormat } from '../structured'

const DEFAULT_ENV = '.env'
const DEFAULT_EXAMPLE = '.env.example'
const KEY_NAME = /^[A-Z_][\w.-]*$/i
const URL_CREDENTIALS = /^([a-z][a-z\d+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@.+)$/i
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const GEN_FORMATS = new Set(['hex', 'base64', 'base64url', 'uuid', 'alnum'])

const templateUsage = `ev template [source] [-o <target>] [--placeholder <text>] [--dry-run] [--json]

Generates or updates a safe example file (.env.example by default) from source (.env by default), keeping comments, blank lines, key order, and non-secret config values while stripping secrets and replacing URL passwords with \`changeme\`.`

const syncUsage = `ev sync [target] [--from <example>] [--dry-run] [--json]

Appends any keys present in the example file (.env.example by default) that are missing from target (.env by default, created if missing), never overwriting existing keys.`

const checkUsage = `ev check [file...] [--json]

Checks .env* files (all folder .env* files by default) for duplicate keys, unterminated quotes, cross-parser Bun/compose quoting hazards, invalid key names, and empty secrets.`

const genUsage = `ev gen <KEY> [file] [--bytes <n>] [--format <hex|base64|base64url|uuid|alnum>] [--force] [--quiet]

Generates a cryptographically random secret and writes it directly to KEY in file (.env by default, or a JSON/YAML/TOML file) without printing the raw secret to stdout or shell history. Refuses to overwrite an existing non-empty value unless --force.`

const TEMPLATE_EXITS: ExitRow[] = [[0, 'template written or printed'], [1, 'source missing or unreadable'], [2, 'a usage error']]
const SYNC_EXITS: ExitRow[] = [[0, 'synced or already up to date'], [1, 'example missing or unreadable'], [2, 'a usage error']]
const CHECK_EXITS: ExitRow[] = [[0, 'no problems found'], [1, 'one or more problems found'], [2, 'a usage error']]
const GEN_EXITS: ExitRow[] = [[0, 'generated and wrote the secret'], [1, 'key already set without --force or file error'], [2, 'a usage error']]

function templateValue(key: string, value: string, placeholder: string): string | undefined {
  if (value === '')
    return ''

  const urlMatch = URL_CREDENTIALS.exec(value)

  if (urlMatch !== null)
    return `${urlMatch[1]}changeme${urlMatch[3]}`

  return isSecretKey(key) || findSecrets(value).length > 0 ? placeholder : undefined
}

export async function template(args: string[]): Promise<number> {
  const parsed = parse(args, templateUsage, {
    'output': { type: 'string', short: 'o', description: 'destination file (.env.example by default)' },
    'placeholder': { type: 'string', description: 'placeholder for redacted secret keys (empty string by default)' },
    'dry-run': { type: 'boolean', short: 'n', description: 'print the generated template without writing it' },
    'json': jsonOption('{source, target, keys, redacted, content?}'),
  }, { positionals: ['[source]'], exits: TEMPLATE_EXITS })

  const [source = DEFAULT_ENV] = parsed.positionals
  const target = parsed.values.output ?? DEFAULT_EXAMPLE
  const placeholder = parsed.values.placeholder ?? ''
  const dryRun = parsed.values['dry-run'] === true

  if (!dryRun)
    assertDotenvName(target)

  const file = await readEnv(source)
  const redacted: string[] = []
  let keys = 0
  const outLines = file.lines.map((line) => {
    if (line.key === undefined)
      return line

    keys += 1

    const replacement = templateValue(line.key, line.value ?? '', placeholder)

    if (replacement === undefined)
      return line

    redacted.push(line.key)

    const formatted = formatAssignment(line.key, replacement) ?? `${line.key}=${replacement}`

    return { raw: formatted, key: line.key, value: replacement }
  })
  const content = serializeDotenv({ lines: outLines })

  if (!dryRun)
    await withLocks([target], async () => writeAtomic(target, content))

  if (parsed.values.json === true) {
    printJson({ source, target, keys, redacted, ...(dryRun ? { content } : {}) })

    return 0
  }

  if (dryRun)
    process.stdout.write(content)
  else
    console.log(`wrote ${role('path', process.stdout)(target)} from ${role('path', process.stdout)(source)} (${keys} keys, ${redacted.length} redacted)`)

  return 0
}

export async function sync(args: string[]): Promise<number> {
  const parsed = parse(args, syncUsage, {
    'from': { type: 'string', description: 'reference example file (.env.example by default)' },
    'dry-run': { type: 'boolean', short: 'n', description: 'show which keys would be added without writing' },
    'json': jsonOption('{from, target, added}'),
  }, { positionals: ['[target]'], exits: SYNC_EXITS })

  const [target = DEFAULT_ENV] = parsed.positionals
  const from = parsed.values.from ?? DEFAULT_EXAMPLE
  const dryRun = parsed.values['dry-run'] === true

  assertDotenvName(target)

  const example = await readEnv(from)
  const existing = await Bun.file(target).exists() ? await readEnv(target) : { lines: [] }
  const have = new Set(entries(existing).keys())
  const added: string[] = []
  const toAppend = example.lines.filter((line) => {
    if (line.key === undefined || have.has(line.key))
      return false

    have.add(line.key)
    added.push(line.key)

    return true
  })

  if (!dryRun && toAppend.length > 0) {
    await withLocks([target], async () => {
      const fresh = await Bun.file(target).exists() ? await readEnv(target) : { lines: [] }

      if (fresh.lines.length > 0 && fresh.lines.at(-1)?.raw !== '')
        fresh.lines.push({ raw: '' })

      fresh.lines.push(...toAppend)
      await writeEnv(target, fresh)
    })
  }

  if (parsed.values.json === true) {
    printJson({ from, target, added })

    return 0
  }

  if (added.length === 0)
    console.log(`${role('path', process.stdout)(target)} already has every key of ${role('path', process.stdout)(from)}`)
  else
    console.log(`${dryRun ? 'would add' : 'added'} ${added.length} ${added.length === 1 ? 'key' : 'keys'} to ${role('path', process.stdout)(target)}: ${added.join(', ')}`)

  return 0
}

interface CheckIssue {
  file: string
  line: number
  severity: 'error' | 'warning'
  key?: string
  message: string
}

const UNQUOTED_SPACE = /^\s*(?:export\s+)?[A-Z_][\w.-]*\s*=\s*[^"'`\s]\S*\s+\S/i

function checkFile(path: string, text: string): CheckIssue[] {
  const issues: CheckIssue[] = []
  const parsed = parseDotenv(text)
  const seen = new Map<string, number>()
  const isTemplate = TEMPLATE.test(path)
  let lineNo = 1

  for (const entry of parsed.lines) {
    const physicalSpan = entry.raw.split('\n').length

    if (entry.key !== undefined) {
      if (!KEY_NAME.test(entry.key))
        issues.push({ file: path, line: lineNo, severity: 'error', key: entry.key, message: `invalid key name ${entry.key}` })

      const first = seen.get(entry.key)

      if (first !== undefined)
        issues.push({ file: path, line: lineNo, severity: 'error', key: entry.key, message: `duplicate key ${entry.key} (first defined on line ${first})` })
      else
        seen.set(entry.key, lineNo)

      if (entry.unterminated === true)
        issues.push({ file: path, line: lineNo, severity: 'error', key: entry.key, message: `unterminated quote on ${entry.key}` })

      const value = entry.value ?? ''

      if (formatAssignment(entry.key, value) === undefined)
        issues.push({ file: path, line: lineNo, severity: 'error', key: entry.key, message: `${entry.key}: ${unquotable(value)}` })

      if (UNQUOTED_SPACE.test(entry.raw) && !entry.raw.includes('#'))
        issues.push({ file: path, line: lineNo, severity: 'warning', key: entry.key, message: `${entry.key}: unquoted value with whitespace parses differently across dotenv loaders` })

      if (!isTemplate && value === '' && isSecretKey(entry.key))
        issues.push({ file: path, line: lineNo, severity: 'warning', key: entry.key, message: `${entry.key} is empty` })
    }

    lineNo += physicalSpan
  }

  return issues
}

export async function check(args: string[]): Promise<number> {
  const parsed = parse(args, checkUsage, { json: jsonOption('[{file, line, severity, key?, message}]') }, { positionals: ['[file...]'], exits: CHECK_EXITS })
  const targets = parsed.positionals.length > 0 ? parsed.positionals : await envFiles()

  if (targets.length === 0)
    fail('no .env* file in this folder', 1)

  const issues: CheckIssue[] = []

  for (const file of targets) {
    if (!await Bun.file(file).exists())
      fail(`${file} does not exist`, 1)

    issues.push(...checkFile(file, await Bun.file(file).text()))
  }

  const hasErrors = issues.some(issue => issue.severity === 'error')

  if (parsed.values.json === true) {
    printJson(issues)

    return hasErrors ? 1 : 0
  }

  if (issues.length === 0) {
    console.log(`ok (${targets.length} ${targets.length === 1 ? 'file' : 'files'} checked)`)

    return 0
  }

  for (const issue of issues)
    console.log(`${issue.file}:${issue.line}: ${issue.severity}: ${issue.message}`)

  return hasErrors ? 1 : 0
}

function generateSecret(bytes: number, format: string): string {
  if (format === 'uuid')
    return randomUUID()

  if (format === 'hex')
    return randomBytes(bytes).toString('hex')

  if (format === 'base64')
    return randomBytes(bytes).toString('base64')

  if (format === 'base64url')
    return randomBytes(bytes).toString('base64url')

  // Rejection-sampled alphanumeric characters to avoid modulo bias.
  const out: string[] = []
  const limit = 256 - (256 % ALNUM.length)

  while (out.length < bytes) {
    for (const byte of randomBytes(bytes)) {
      if (byte < limit && out.length < bytes)
        out.push(ALNUM[byte % ALNUM.length]!)
    }
  }

  return out.join('')
}

export async function gen(args: string[]): Promise<number> {
  const parsed = parse(args, genUsage, {
    bytes: { type: 'string', short: 'b', description: 'number of random bytes (or characters for alnum); default 32' },
    format: { type: 'string', short: 'f', description: 'output encoding: hex (default), base64, base64url, uuid, or alnum', candidates: () => [...GEN_FORMATS] },
    force: { type: 'boolean', description: 'overwrite KEY even if it already has a non-empty value' },
    quiet: { type: 'boolean', short: 'q', description: 'print nothing on success' },
  }, { positionals: ['<key>', '[file]'], exits: GEN_EXITS })

  const [key, target = DEFAULT_ENV] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${genUsage}`)

  const format = parsed.values.format ?? 'hex'

  if (!GEN_FORMATS.has(format))
    badUsage(`--format must be one of ${[...GEN_FORMATS].join(', ')}`)

  const bytes = parsed.values.bytes === undefined ? 32 : wholeNumber(parsed.values.bytes, '--bytes', 32, 8)
  const value = generateSecret(bytes, format)
  const force = parsed.values.force === true

  if (structuredFormat(target) !== undefined) {
    if (key.split('.').includes(''))
      badUsage(`${JSON.stringify(key)} is not a valid dotted path`)

    const fileHandle = Bun.file(target)

    if (!await fileHandle.exists())
      fail(`${target} does not exist: ev writes into a JSON, YAML or TOML file that is there`, 1)

    const { setStructured } = await import('../structured-write')
    const edited = await withLocks([target], async () => {
      const currentText = await fileHandle.text()
      const currentMap = parseStructured(target, currentText)

      if (!force && (currentMap.get(key) ?? '') !== '')
        fail(`${key} is already set in ${target}, pass --force to rotate it`, 1)

      const next = setStructured(target, currentText, key, value)

      await writeAtomic(target, next)

      return next
    })

    if (parsed.values.quiet !== true)
      console.log(`${target}: ${key}=${maskValue(key, value, await loadKnown(process.cwd(), [parseStructured(target, edited)]))}`)

    return 0
  }

  if (!KEY_NAME.test(key))
    badUsage(`${JSON.stringify(key)} is not a valid key`)

  assertDotenvName(target)

  const written = await withLocks([target], async () => {
    const current = await Bun.file(target).exists() ? await readEnv(target) : { lines: [] }

    if (!force && (entries(current).get(key) ?? '') !== '')
      fail(`${key} is already set in ${target}, pass --force to rotate it`, 1)

    setLine(current, key, value)
    await writeEnv(target, current)

    return current
  })

  if (parsed.values.quiet !== true)
    console.log(`${target}: ${key}=${maskValue(key, value, await loadKnown(process.cwd(), [entries(written)]))}`)

  return 0
}
