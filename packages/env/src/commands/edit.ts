import { fail, parse, readInput } from '@kaynooo/cli-kit'
import { entries, lastLine, removeKey, setLine } from '../dotenv'
import { readEnv, writeEnv } from '../files'
import { maskValue } from '../mask'

const DEFAULT_FILE = '.env'
const TRAILING_NEWLINE = /\r?\n$/

const setUsage = `ev set KEY [file]

Sets KEY in the file (.env by default, created when missing), replacing its line in place or appending one. The value is read from stdin, or from -F <file>, so it never appears in a command line; --empty sets it to an empty value.

Exits 0 when it wrote the key, 1 when it could not, 2 on a usage error.`

const unsetUsage = `ev unset KEY [file]

Removes every line setting KEY from the file (.env by default), leaving comments and other lines as they are.

Exits 0 when it removed the key, 1 when the file does not set it, 2 on a usage error.`

const mvUsage = `ev mv KEY --from <file> --to <file>

Moves KEY's line from one file to another, as written. Refuses to replace a key the target already sets unless --force.

Exits 0 when it moved the key, 1 when the source lacks it or the target already sets it, 2 on a usage error.`

const cpUsage = `ev cp KEY --from <file> --to <file> [--as NEWKEY]

Copies KEY's value from one file to another without printing it, replacing the key's line in the target in place or appending one, and prints the masked result as ev set does. --as stores the copy under another key.

Exits 0 when it copied the key, 1 when the source lacks it, 2 on a usage error.`

async function readValue(from: string | undefined): Promise<string> {
  const input = await readInput(from ?? '-', { noStdin: 'pipe the value on stdin or give -F <file>, it is never taken from the command line' })

  if (input === '')
    fail('the value is empty, nothing was written: --empty sets an empty value')

  return input.replace(TRAILING_NEWLINE, '')
}

async function readOrEmpty(path: string) {
  return await Bun.file(path).exists() ? readEnv(path) : { lines: [] }
}

export async function set(args: string[]): Promise<number> {
  const parsed = parse(args, setUsage, {
    file: { type: 'string', short: 'F', description: 'read the value from this file instead of stdin' },
    empty: { type: 'boolean', description: 'set an empty value, reading nothing' },
  })

  const [key, target = DEFAULT_FILE] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${setUsage}`)

  if (parsed.values.empty === true && parsed.values.file !== undefined)
    fail('--empty and -F exclude each other')

  const value = parsed.values.empty === true ? '' : await readValue(parsed.values.file)
  const file = await readOrEmpty(target)

  setLine(file, key, value)
  await writeEnv(target, file)
  console.log(`${target}: ${key}=${maskValue(key, value).replaceAll('\n', '\\n')}`)

  return 0
}

export async function unset(args: string[]): Promise<number> {
  const parsed = parse(args, unsetUsage, {})

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

// The write path of mv and cp: puts KEY's line from `from` into `to`, as `newKey` when given, and returns both files for the caller to finish.
async function transfer(key: string, from: string, to: string, newKey: string | undefined, replace: boolean) {
  if (from === to && newKey === undefined)
    fail('--from and --to are the same file')

  const source = await readEnv(from)
  const line = lastLine(source, key)

  if (line === undefined)
    fail(`${key} is not set in ${from}`, 1)

  const target = from === to ? source : await readOrEmpty(to)
  const name = newKey ?? key

  if (!replace && entries(target).has(name))
    fail(`${to} already sets ${name}, --force replaces it`, 1)

  const value = line.value ?? ''

  setLine(target, name, value, newKey === undefined && !entries(target).has(name) ? line.raw : undefined)
  await writeEnv(to, target)

  return { source, value, name }
}

export async function mv(args: string[]): Promise<number> {
  const parsed = parse(args, mvUsage, {
    from: { type: 'string', description: 'the file to take KEY from' },
    to: { type: 'string', description: 'the file to put KEY in, created when missing' },
    force: { type: 'boolean', description: 'replace KEY when the target already sets it' },
  })

  const [key] = parsed.positionals
  const { from, to, force } = parsed.values

  if (key === undefined || from === undefined || to === undefined)
    fail(`needs KEY, --from and --to\n\n${mvUsage}`)

  const { source } = await transfer(key, from, to, undefined, force === true)

  removeKey(source, key)
  await writeEnv(from, source)
  console.log(`${key}: ${from} -> ${to}`)

  return 0
}

export async function cp(args: string[]): Promise<number> {
  const parsed = parse(args, cpUsage, {
    from: { type: 'string', description: 'the file to take KEY from' },
    to: { type: 'string', description: 'the file to put the copy in, created when missing' },
    as: { type: 'string', description: 'store the copy under this key instead' },
  })

  const [key] = parsed.positionals
  const { from, to, as } = parsed.values

  if (key === undefined || from === undefined || to === undefined)
    fail(`needs KEY, --from and --to\n\n${cpUsage}`)

  const { value, name } = await transfer(key, from, to, as, true)

  console.log(`${to}: ${name}=${maskValue(name, value).replaceAll('\n', '\\n')}`)

  return 0
}
