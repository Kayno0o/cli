import process from 'node:process'
import { fail, jsonOption, parse, printJson, role } from '@kaynooo/cli-kit'
import { entries } from '../dotenv'
import { readEnv } from '../files'

const diffUsage = `ev diff <a> <b>

Names the keys set in one file and not the other, never their values.

--json prints {a, b, onlyA, onlyB}.

Exits 0 when both set the same keys, 1 when they differ, 2 on a usage error.`

const missingUsage = `ev missing [file]

Names the keys the reference file sets that the file (.env by default) does not.

--json prints {a, b, onlyA, onlyB} with the reference as a, so onlyA is what is missing.

Exits 0 when none is missing, 1 when some are, 2 on a usage error.`

const jsonFlag = { json: jsonOption() } as const

async function keys(path: string): Promise<Set<string>> {
  return new Set(entries(await readEnv(path)).keys())
}

export async function diff(args: string[]): Promise<number> {
  const parsed = parse(args, diffUsage, jsonFlag)

  const [a, b] = parsed.positionals

  if (a === undefined || b === undefined)
    fail(`needs two files\n\n${diffUsage}`)

  const left = await keys(a)
  const right = await keys(b)
  const onlyA = [...left].filter(key => !right.has(key))
  const onlyB = [...right].filter(key => !left.has(key))

  if (parsed.values.json === true) {
    printJson({ a, b, onlyA, onlyB })

    return onlyA.length + onlyB.length === 0 ? 0 : 1
  }

  const path = role('path', process.stdout)
  const value = role('value', process.stdout)
  const lines = [...onlyA.map(key => `only in ${path(a)}: ${value(key)}`), ...onlyB.map(key => `only in ${path(b)}: ${value(key)}`)]

  if (lines.length === 0)
    return 0

  console.log(lines.join('\n'))

  return 1
}

export async function missing(args: string[]): Promise<number> {
  const parsed = parse(args, missingUsage, { against: { type: 'string', description: 'the reference file (.env.example by default)' }, ...jsonFlag })

  const [file = '.env'] = parsed.positionals
  const against = parsed.values.against ?? '.env.example'
  const have = await keys(file)
  const reference = await keys(against)
  const absent = [...reference].filter(key => !have.has(key))

  if (parsed.values.json === true) {
    printJson({ a: against, b: file, onlyA: absent, onlyB: [...have].filter(key => !reference.has(key)) })

    return absent.length === 0 ? 0 : 1
  }

  if (absent.length === 0)
    return 0

  const path = role('path', process.stdout)
  const value = role('value', process.stdout)

  console.log(absent.map(key => `${value(key)} (set in ${path(against)}, not in ${path(file)})`).join('\n'))

  return 1
}
