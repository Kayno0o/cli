import { fail, parse } from '@kaynooo/cli-kit'
import { entries } from '../dotenv'
import { readEnv } from '../files'

const diffUsage = `ev diff <a> <b>

Names the keys set in one file and not the other, never their values.

Exits 0 when both set the same keys, 1 when they differ, 2 on a usage error.`

const missingUsage = `ev missing [file]

Names the keys the reference file sets that the file (.env by default) does not.

Exits 0 when none is missing, 1 when some are, 2 on a usage error.`

async function keys(path: string): Promise<Set<string>> {
  return new Set(entries(await readEnv(path)).keys())
}

export async function diff(args: string[]): Promise<number> {
  const parsed = parse(args, diffUsage, {})

  const [a, b] = parsed.positionals

  if (a === undefined || b === undefined)
    fail(`needs two files\n\n${diffUsage}`)

  const left = await keys(a)
  const right = await keys(b)
  const lines = [
    ...[...left].filter(key => !right.has(key)).map(key => `only in ${a}: ${key}`),
    ...[...right].filter(key => !left.has(key)).map(key => `only in ${b}: ${key}`),
  ]

  if (lines.length === 0)
    return 0

  console.log(lines.join('\n'))

  return 1
}

export async function missing(args: string[]): Promise<number> {
  const parsed = parse(args, missingUsage, { against: { type: 'string', description: 'the reference file (.env.example by default)' } })

  const [file = '.env'] = parsed.positionals
  const against = parsed.values.against ?? '.env.example'
  const have = await keys(file)
  const absent = [...await keys(against)].filter(key => !have.has(key))

  if (absent.length === 0)
    return 0

  console.log(absent.map(key => `${key} (set in ${against}, not in ${file})`).join('\n'))

  return 1
}
