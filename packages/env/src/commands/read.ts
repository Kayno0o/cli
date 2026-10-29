import { fail, parse, table } from '@kaynooo/cli-kit'
import { entries } from '../dotenv'
import { envFiles, readEnv } from '../files'
import { maskValue } from '../mask'

const listUsage = `ev list [file]

Prints every key of the folder's .env* files, or of one file, with secret values masked: a few leading characters and the length under a key named like TOKEN, SECRET, PASSWORD, KEY, PRIVATE or DSN, and the password of any URL.`

const getUsage = `ev get KEY [file]

Prints the masked value of one key, from every .env* file that sets it or from one file.`

function display(key: string, value: string): string {
  return maskValue(key, value).replaceAll('\n', '\\n').replaceAll('\r', '\\r')
}

export async function list(args: string[]): Promise<number> {
  const parsed = parse(args, listUsage, {})

  if (parsed === undefined)
    return 0

  const [file] = parsed.positionals
  const names = file === undefined ? await envFiles() : [file]

  if (names.length === 0)
    fail('no .env* file in this folder', 1)

  const rows: string[][] = []

  for (const name of names) {
    for (const [key, value] of entries(await readEnv(name)))
      rows.push([name, key, display(key, value)])
  }

  if (rows.length > 0)
    console.log(table(rows))

  return 0
}

export async function get(args: string[]): Promise<number> {
  const parsed = parse(args, getUsage, {})

  if (parsed === undefined)
    return 0

  const [key, file] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${getUsage}`)

  const names = file === undefined ? await envFiles() : [file]
  const rows: string[][] = []

  for (const name of names) {
    const value = entries(await readEnv(name)).get(key)

    if (value !== undefined)
      rows.push([name, display(key, value)])
  }

  if (rows.length === 0)
    fail(`${key} is not set in ${file ?? 'any .env* file'}`, 1)

  console.log(file === undefined ? table(rows) : rows[0]?.[1])

  return 0
}
