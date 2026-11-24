import type { ExitRow } from '@kaynooo/cli-kit'
import { badUsage, fail, isInteractive, parse, readInput } from '@kaynooo/cli-kit'
import { input } from '@kaynooo/cli-kit/prompt'
import { entries, formatAssignment, lastLine, removeKey, setLine, unquotable } from '../dotenv'
import { assertDotenvName, loadKnown, readEnv, withLocks, writeAtomic, writeEnv } from '../files'
import { maskValue } from '../mask'
import { parseStructured, structuredFormat } from '../structured'
import { keyCandidates } from './read'

const DEFAULT_FILE = '.env'
const TRAILING_NEWLINE = /\r?\n$/
const KEY_NAME = /^[A-Z_][\w.-]*$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F]/

const QUIET = { quiet: { type: 'boolean', short: 'q', description: 'print nothing on success' } } as const

const setUsage = `ev set KEY [file] [--quiet]

Sets KEY in the file (.env by default, created when missing), replacing its line in place or appending one. The value is read from stdin, or from -F <file>, so it never appears in a command line; on a terminal with nothing piped it is asked for, masked as it is typed. --empty sets it to an empty value. The value is written in the quoting Bun's --env-file and compose's env_file both read back unchanged, and refused when none does, as for one holding both a dollar sign and a backslash.

In a JSON, YAML or TOML file that exists, KEY is a dotted path (database.password, servers.0.host), and only its value changes: comments, order, indentation and the value's quoting stay, a number or boolean stays one when the value reads as one, and an edit that would change anything else is refused.`

const SET_EXITS: ExitRow[] = [[0, 'it wrote the key'], [1, 'it could not'], [2, 'a usage error'], [130, 'the prompt was cancelled']]

const unsetUsage = `ev unset KEY [file] [--quiet]

Removes every line setting KEY from the file (.env by default), leaving comments and other lines as they are. In a JSON, YAML or TOML file KEY is a dotted path to a value, removed with its line.`

const UNSET_EXITS: ExitRow[] = [[0, 'it removed the key'], [1, 'the file does not set it'], [2, 'a usage error']]

const mvUsage = `ev mv KEY --from <file> --to <file> [--quiet]

Moves KEY's line from one file to another, as written. Refuses to replace a key the target already sets unless --force, and with --force a value no quoting keeps for both Bun and compose, as ev set does.`

const MV_EXITS: ExitRow[] = [[0, 'it moved the key'], [1, 'the source lacks it, the target already sets it, or its value cannot be rewritten'], [2, 'a usage error']]

const cpUsage = `ev cp KEY --from <file> --to <file> [--as NEWKEY] [--quiet]

Copies KEY's value from one file to another without printing it, replacing the key's line in the target in place or appending one, and prints the masked result as ev set does. --as stores the copy under another key. A value it has to rewrite is refused when no quoting keeps it for both Bun and compose, as ev set does.`

const CP_EXITS: ExitRow[] = [[0, 'it copied the key'], [1, 'the source lacks it or its value cannot be rewritten'], [2, 'a usage error']]

async function readValue(key: string, from: string | undefined): Promise<string> {
  const value = from === undefined && isInteractive()
    ? await input(`value of ${key}`, { mask: true, hint: 'pipe the value on stdin or pass -F <file>' }) ?? fail('cancelled, nothing was written', 130)
    : await readInput(from ?? '-', { noStdin: 'pipe the value on stdin or give -F <file>, it is never taken from the command line' })

  const stripped = value.replace(TRAILING_NEWLINE, '')

  if (stripped === '')
    fail('the value is empty, nothing was written: --empty sets an empty value')

  return stripped
}

// A key that is not a plain name could carry a line break or an `=` and write more than one line. A JSON, YAML or TOML file quotes its keys, so a dotted path there only needs each part named.
function checkKey(key: string, target: string): void {
  if (structuredFormat(target) !== undefined) {
    if (key.split('.').includes('') || CONTROL.test(key))
      badUsage(`${JSON.stringify(key)} is not a path of keys: names joined by dots, none empty`)

    return
  }

  if (!KEY_NAME.test(key))
    badUsage(`${JSON.stringify(key)} is not a valid key: letters, digits, _, . and - only, not starting with a digit`)
}

async function readStructured(path: string): Promise<string> {
  const file = Bun.file(path)

  return await file.exists() ? file.text() : fail(`${path} does not exist: ev writes into a JSON, YAML or TOML file that is there`, 1)
}

async function readOrEmpty(path: string) {
  assertDotenvName(path)

  return await Bun.file(path).exists() ? readEnv(path) : { lines: [] }
}

export async function set(args: string[]): Promise<number> {
  const parsed = parse(args, setUsage, {
    file: { type: 'string', short: 'F', description: 'read the value from this file instead of stdin' },
    empty: { type: 'boolean', description: 'set an empty value, reading nothing' },
    ...QUIET,
  }, { positionals: ['[key]', '[file]'], candidates: { '[key]': keyCandidates }, exits: SET_EXITS })

  const [key, target = DEFAULT_FILE] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${setUsage}`)

  if (parsed.values.empty === true && parsed.values.file !== undefined)
    fail('--empty and -F exclude each other')

  checkKey(key, target)

  const value = parsed.values.empty === true ? '' : await readValue(key, parsed.values.file)

  if (structuredFormat(target) !== undefined) {
    const { setStructured } = await import('../structured-write')
    const text = await withLocks([target], async () => {
      const edited = setStructured(target, await readStructured(target), key, value)

      await writeAtomic(target, edited)

      return edited
    })

    if (parsed.values.quiet !== true)
      console.log(`${target}: ${key}=${maskValue(key, value, await loadKnown(process.cwd(), [parseStructured(target, text)])).replaceAll('\n', '\\n')}`)

    return 0
  }

  if (formatAssignment(key, value) === undefined)
    fail(`${unquotable(value)}, nothing was written`, 1)

  const file = await withLocks([target], async () => {
    const current = await readOrEmpty(target)

    setLine(current, key, value)
    await writeEnv(target, current)

    return current
  })

  if (parsed.values.quiet !== true)
    console.log(`${target}: ${key}=${maskValue(key, value, await loadKnown(process.cwd(), [entries(file)])).replaceAll('\n', '\\n')}`)

  return 0
}

export async function unset(args: string[]): Promise<number> {
  const parsed = parse(args, unsetUsage, QUIET, { positionals: ['[key]', '[file]'], candidates: { '[key]': keyCandidates }, exits: UNSET_EXITS })

  const [key, target = DEFAULT_FILE] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${unsetUsage}`)

  if (structuredFormat(target) !== undefined)
    checkKey(key, target)

  await withLocks([target], async () => {
    if (structuredFormat(target) !== undefined) {
      const { unsetStructured } = await import('../structured-write')

      await writeAtomic(target, unsetStructured(target, await readStructured(target), key) ?? fail(`${key} is not set in ${target}`, 1))

      return
    }

    const file = await readEnv(target)

    if (removeKey(file, key) === 0)
      fail(`${key} is not set in ${target}`, 1)

    await writeEnv(target, file)
  })

  if (parsed.values.quiet !== true)
    console.log(`${target}: removed ${key}`)

  return 0
}

// The write path of mv and cp: puts KEY from `from` into `to` (supporting dotenv, JSON, YAML, and TOML on either side), as `newKey` when given.
async function transfer(key: string, from: string, to: string, newKey: string | undefined, replace: boolean, removeFromSource: boolean): Promise<{ sourceKeys: Map<string, string>, targetKeys: Map<string, string>, value: string, name: string }> {
  checkKey(key, from)

  const name = newKey ?? key

  checkKey(name, to)

  if (from === to && newKey === undefined)
    fail('--from and --to are the same file')

  const fromStructured = structuredFormat(from) !== undefined
  const toStructured = structuredFormat(to) !== undefined

  let value: string
  let rawLine: string | undefined
  let sourceDotenv: Awaited<ReturnType<typeof readEnv>> | undefined
  let sourceText: string | undefined
  let sourceKeys: Map<string, string>

  if (fromStructured) {
    sourceText = await readStructured(from)
    sourceKeys = parseStructured(from, sourceText)

    const found = sourceKeys.get(key)

    if (found === undefined)
      fail(`${key} is not set in ${from}`, 1)

    value = found
  }
  else {
    sourceDotenv = await readEnv(from)

    const line = lastLine(sourceDotenv, key)

    if (line === undefined)
      fail(`${key} is not set in ${from}`, 1)

    value = line.value ?? ''
    rawLine = line.raw
    sourceKeys = entries(sourceDotenv)
  }

  let targetKeys: Map<string, string>

  if (toStructured) {
    const { setStructured } = await import('../structured-write')
    const currentText = from === to && sourceText !== undefined ? sourceText : await readStructured(to)
    const currentMap = parseStructured(to, currentText)

    if (!replace && currentMap.has(name))
      fail(`${to} already sets ${name}, --force replaces it`, 1)

    const edited = setStructured(to, currentText, name, value)

    if (from === to) {
      sourceText = edited
    }
    else {
      await writeAtomic(to, edited)
    }

    targetKeys = parseStructured(to, edited)
  }
  else {
    const target = from === to && sourceDotenv !== undefined ? sourceDotenv : await readOrEmpty(to)

    if (!replace && entries(target).has(name))
      fail(`${to} already sets ${name}, --force replaces it`, 1)

    const raw = !fromStructured && newKey === undefined && !entries(target).has(name) ? rawLine : undefined

    if (raw === undefined && formatAssignment(name, value) === undefined)
      fail(`${key} in ${from}: ${unquotable(value)}, nothing was written`, 1)

    setLine(target, name, value, raw)
    await writeEnv(to, target)
    targetKeys = entries(target)
  }

  if (removeFromSource) {
    if (fromStructured && sourceText !== undefined) {
      const { unsetStructured } = await import('../structured-write')
      const removed = unsetStructured(from, sourceText, key)

      if (removed === undefined)
        fail(`${key} is not set in ${from}`, 1)

      await writeAtomic(from, removed)
    }
    else if (sourceDotenv !== undefined) {
      removeKey(sourceDotenv, key)
      await writeEnv(from, sourceDotenv)
    }
  }
  else if (from === to && toStructured && sourceText !== undefined) {
    await writeAtomic(to, sourceText)
  }

  return { sourceKeys, targetKeys, value, name }
}

export async function mv(args: string[]): Promise<number> {
  const parsed = parse(args, mvUsage, {
    from: { type: 'string', description: 'the file to take KEY from' },
    to: { type: 'string', description: 'the file to put KEY in, created when missing' },
    force: { type: 'boolean', description: 'replace KEY when the target already sets it' },
    ...QUIET,
  }, { positionals: ['[key]'], candidates: { '[key]': keyCandidates }, exits: MV_EXITS })

  const [key] = parsed.positionals
  const { from, to, force } = parsed.values

  if (key === undefined || from === undefined || to === undefined)
    fail(`needs KEY, --from and --to\n\n${mvUsage}`)

  await withLocks([from, to], async () => transfer(key, from, to, undefined, force === true, true))

  if (parsed.values.quiet !== true)
    console.log(`${key}: ${from} -> ${to}`)

  return 0
}

export async function cp(args: string[]): Promise<number> {
  const parsed = parse(args, cpUsage, {
    from: { type: 'string', description: 'the file to take KEY from' },
    to: { type: 'string', description: 'the file to put the copy in, created when missing' },
    as: { type: 'string', description: 'store the copy under this key instead' },
    ...QUIET,
  }, { positionals: ['[key]'], candidates: { '[key]': keyCandidates }, exits: CP_EXITS })

  const [key] = parsed.positionals
  const { from, to, as } = parsed.values

  if (key === undefined || from === undefined || to === undefined)
    fail(`needs KEY, --from and --to\n\n${cpUsage}`)

  const { sourceKeys, targetKeys, value, name } = await withLocks([from, to], async () => transfer(key, from, to, as, true, false))

  if (parsed.values.quiet !== true)
    console.log(`${to}: ${name}=${maskValue(name, value, await loadKnown(process.cwd(), [sourceKeys, targetKeys])).replaceAll('\n', '\\n')}`)

  return 0
}
