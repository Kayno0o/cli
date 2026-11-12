import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, role } from '@kaynooo/cli-kit'
import { loadKnown, readEntries } from '../files'
import { display } from './read'

const diffUsage = `ev diff <a> <b>

Names the keys set in one file and not the other, and those both set to different values, each value masked as ev list does.

--keys compares the keys only.
--json prints {a, b, onlyA, onlyB, differ}, differ naming the keys only.`

const DIFF_EXITS: ExitRow[] = [[0, 'both set the same keys to the same values'], [1, 'they differ'], [2, 'a usage error']]

const missingUsage = `ev missing [file]

Names the keys the reference file sets that the file (.env by default) does not.

--json prints {a, b, onlyA, onlyB} with the reference as a, so onlyA is what is missing.`

const MISSING_EXITS: ExitRow[] = [[0, 'none is missing'], [1, 'some are'], [2, 'a usage error']]

const jsonFlag = { json: jsonOption() } as const

async function keys(path: string): Promise<Set<string>> {
  return new Set((await readEntries(path)).keys())
}

// Running ev reads both files already, and `ev redact` tells whether a string is one of their secrets, so naming a value as changed gives nothing away.
export async function diff(args: string[]): Promise<number> {
  const parsed = parse(args, diffUsage, { keys: { type: 'boolean', description: 'compare the keys only' }, ...jsonFlag }, { exits: DIFF_EXITS })

  const [a, b] = parsed.positionals

  if (a === undefined || b === undefined)
    fail(`needs two files\n\n${diffUsage}`)

  const left = await readEntries(a)
  const right = await readEntries(b)
  const onlyA = [...left.keys()].filter(key => !right.has(key))
  const onlyB = [...right.keys()].filter(key => !left.has(key))
  const differ = parsed.values.keys === true ? [] : [...left].filter(([key, value]) => right.has(key) && right.get(key) !== value).map(([key]) => key)
  const same = onlyA.length + onlyB.length + differ.length === 0

  if (parsed.values.json === true) {
    printJson({ a, b, onlyA, onlyB, differ })

    return same ? 0 : 1
  }

  const path = role('path', process.stdout)
  const value = role('value', process.stdout)
  const known = differ.length ? await loadKnown(process.cwd(), [left, right]) : undefined
  const shown = (key: string, raw: string) => raw === '' ? 'empty' : display(key, raw, known)
  const lines = [
    ...onlyA.map(key => `only in ${path(a)}: ${value(key)}`),
    ...onlyB.map(key => `only in ${path(b)}: ${value(key)}`),
    ...differ.map(key => `differs: ${value(key)} (${shown(key, left.get(key)!)} in ${path(a)}, ${shown(key, right.get(key)!)} in ${path(b)})`),
  ]

  if (same)
    return 0

  console.log(lines.join('\n'))

  return 1
}

export async function missing(args: string[]): Promise<number> {
  const parsed = parse(args, missingUsage, { against: { type: 'string', description: 'the reference file (.env.example by default)' }, ...jsonFlag }, { exits: MISSING_EXITS })

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
