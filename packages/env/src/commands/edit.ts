import process from 'node:process'
import { fail, parse } from '@kaynooo/cli-kit'
import { entries, lastLine, removeKey, setLine } from '../dotenv'
import { readEnv, writeEnv } from '../files'
import { maskValue } from '../mask'

const DEFAULT_FILE = '.env'
const TRAILING_NEWLINE = /\r?\n$/

const setUsage = `ev set KEY [file]

Sets KEY in the file (.env by default, created when missing), replacing its line in place or appending one. The value is read from stdin, or from -F <file>, so it never appears in a command line.`

const unsetUsage = `ev unset KEY [file]

Removes every line setting KEY from the file (.env by default), leaving comments and other lines as they are.`

const mvUsage = `ev mv KEY --from <file> --to <file>

Moves KEY's line from one file to another, as written. Refuses to replace a key the target already sets unless --force.`

async function readValue(from: string | undefined): Promise<string> {
  if (from === undefined && process.stdin.isTTY)
    fail('pipe the value on stdin or give -F <file>, it is never taken from the command line')

  const input = from === undefined ? await Bun.stdin.text() : await readFile(from)

  if (input === '')
    fail('the value is empty, nothing was written')

  return input.replace(TRAILING_NEWLINE, '')
}

async function readFile(path: string): Promise<string> {
  const file = Bun.file(path)

  if (!await file.exists())
    fail(`${path} does not exist`)

  return file.text()
}

async function readOrEmpty(path: string) {
  return await Bun.file(path).exists() ? readEnv(path) : { lines: [] }
}

export async function set(args: string[]): Promise<number> {
  const parsed = parse(args, setUsage, { file: { type: 'string', short: 'F', description: 'read the value from this file instead of stdin' } })

  if (parsed === undefined)
    return 0

  const [key, target = DEFAULT_FILE] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${setUsage}`)

  const value = await readValue(parsed.values.file)
  const file = await readOrEmpty(target)

  setLine(file, key, value)
  await writeEnv(target, file)
  console.log(`${target}: ${key}=${maskValue(key, value).replaceAll('\n', '\\n')}`)

  return 0
}

export async function unset(args: string[]): Promise<number> {
  const parsed = parse(args, unsetUsage, {})

  if (parsed === undefined)
    return 0

  const [key, target = DEFAULT_FILE] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${unsetUsage}`)

  const file = await readEnv(target)

  if (removeKey(file, key) === 0)
    fail(`${key} is not set in ${target}`, 1)

  await writeEnv(target, file)
  console.log(`${target}: removed ${key}`)

  return 0
}

export async function mv(args: string[]): Promise<number> {
  const parsed = parse(args, mvUsage, {
    from: { type: 'string', description: 'the file to take KEY from' },
    to: { type: 'string', description: 'the file to put KEY in, created when missing' },
    force: { type: 'boolean', description: 'replace KEY when the target already sets it' },
  })

  if (parsed === undefined)
    return 0

  const [key] = parsed.positionals
  const { from, to, force } = parsed.values

  if (key === undefined || from === undefined || to === undefined)
    fail(`needs KEY, --from and --to\n\n${mvUsage}`)

  if (from === to)
    fail('--from and --to are the same file')

  const source = await readEnv(from)
  const line = lastLine(source, key)

  if (line === undefined)
    fail(`${key} is not set in ${from}`, 1)

  const target = await readOrEmpty(to)

  if (entries(target).has(key) && force !== true)
    fail(`${to} already sets ${key}, --force replaces it`, 1)

  setLine(target, key, line.value ?? '', line.raw)
  await writeEnv(to, target)
  removeKey(source, key)
  await writeEnv(from, source)
  console.log(`${key}: ${from} -> ${to}`)

  return 0
}
