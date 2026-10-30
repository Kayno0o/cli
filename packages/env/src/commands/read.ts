import { fail, parse, table } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { entries, parseDotenv } from '../dotenv'
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

const grepUsage = `ev grep [-i] <regex> [file...]

Prints the keys matching the regular expression, from the folder's .env* files or the files given, with their values masked as ev list does. The regex is matched against the key only, never the value: \`ev grep '^DATABASE_'\` instead of \`grep ^DATABASE_ .env\`.`

const showUsage = `ev show <rev>:<file>

Prints every key of an env file as a git revision holds it, values masked as ev list does: \`ev show HEAD~1:api/.env\` instead of \`git show HEAD~1:api/.env\`.`

const REVISION = /^([^:]+):(.+)$/

export async function grep(args: string[]): Promise<number> {
  const parsed = parse(args, grepUsage, { 'ignore-case': { type: 'boolean', short: 'i', description: 'match the key whatever its case' } })

  if (parsed === undefined)
    return 0

  const [source, ...files] = parsed.positionals

  if (source === undefined)
    fail(`missing the regex\n\n${grepUsage}`)

  let pattern: RegExp

  try {
    pattern = new RegExp(source, parsed.values['ignore-case'] === true ? 'i' : '')
  }
  catch (error) {
    fail(`${source} is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const names = files.length === 0 ? await envFiles() : files
  const rows: string[][] = []

  for (const name of names) {
    for (const [key, value] of entries(await readEnv(name))) {
      if (pattern.test(key))
        rows.push([name, key, display(key, value)])
    }
  }

  if (rows.length === 0)
    fail(`no key matches ${source} in ${names.join(', ') || 'any .env* file'}`, 1)

  console.log(table(rows))

  return 0
}

export async function show(args: string[]): Promise<number> {
  const parsed = parse(args, showUsage, {})

  if (parsed === undefined)
    return 0

  const [target] = parsed.positionals
  const [, revision, path] = REVISION.exec(target ?? '') ?? []

  if (revision === undefined || path === undefined)
    fail(`give <rev>:<file>\n\n${showUsage}`)

  const shown = await $`git show ${`${revision}:${path}`}`.quiet().nothrow()

  if (shown.exitCode !== 0)
    fail(`git show ${revision}:${path} failed: ${shown.stderr.toString().trim()}`, 1)

  const rows = [...entries(parseDotenv(shown.stdout.toString()))].map(([key, value]) => [key, display(key, value)])

  if (rows.length > 0)
    console.log(table(rows))

  return 0
}
