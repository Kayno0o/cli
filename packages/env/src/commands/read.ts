import type { Dotenv } from '../dotenv'
import type { KnownSecrets } from '../mask'
import { fail, jsonOption, parse, printJson, role, table } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { entries, parseDotenv } from '../dotenv'
import { envFiles, loadKnown, readEnv } from '../files'
import { isSecretKey, maskValue } from '../mask'

const listUsage = `ev list [file]

Prints every key of the folder's .env* files, or of one file, with secret values masked: a few leading characters and the length under a key named like TOKEN, SECRET, PASSWORD, PASS, PWD, KEY, PRIVATE, DSN, AUTH, SALT or COOKIE, any value equal to a secret of the folder's .env* files, and the password and tokens of any URL.

--json prints [{file, key, value, secret}], value masked and secret true when a value was.

Exits 0 when it printed them, 1 when there is no .env* file, 2 on a usage error.`

const getUsage = `ev get KEY [file]

Prints the masked value of one key, from every .env* file that sets it or from one file.

--json prints [{file, key, value, secret}] for each file that sets it.

Exits 0 when the key is set, 1 when it is not set anywhere, 2 on a usage error.`

function display(key: string, value: string, known: KnownSecrets): string {
  return maskValue(key, value, known).replaceAll('\n', '\\n').replaceAll('\r', '\\r')
}

const jsonFlag = { json: jsonOption() } as const

interface Row { file: string, key: string, value: string, secret: boolean }

// A value is secret when it is masked, or when its key is named like a secret even with nothing to mask.
function row(file: string, key: string, value: string, known: KnownSecrets): Row {
  const shown = display(key, value, known)

  return { file, key, value: shown, secret: shown !== value.replaceAll('\n', '\\n').replaceAll('\r', '\\r') || isSecretKey(key) }
}

function printRows(rows: Row[], json: boolean, plain: () => void): void {
  if (json)
    printJson(rows)
  else
    plain()
}

// Reads each file once and learns the secrets of the folder and of these files, so a value is masked whatever key holds it.
async function readAll(names: string[]): Promise<{ files: [name: string, file: Dotenv][], known: KnownSecrets }> {
  const files: [string, Dotenv][] = []

  for (const name of names)
    files.push([name, await readEnv(name)])

  return { files, known: await loadKnown(process.cwd(), files.map(([, file]) => file)) }
}

export async function list(args: string[]): Promise<number> {
  const parsed = parse(args, listUsage, jsonFlag)

  const [file] = parsed.positionals
  const names = file === undefined ? await envFiles() : [file]

  if (names.length === 0)
    fail('no .env* file in this folder', 1)

  const rows: Row[] = []

  const { files, known } = await readAll(names)

  for (const [name, file] of files) {
    for (const [key, value] of entries(file))
      rows.push(row(name, key, value, known))
  }

  printRows(rows, parsed.values.json === true, () => {
    if (rows.length > 0)
      console.log(table(rows.map(each => [role('path', process.stdout)(each.file), role('value', process.stdout)(each.key), each.value])))
  })

  return 0
}

export async function get(args: string[]): Promise<number> {
  const parsed = parse(args, getUsage, jsonFlag)

  const [key, file] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${getUsage}`)

  const names = file === undefined ? await envFiles() : [file]
  const rows: Row[] = []

  const { files, known } = await readAll(names)

  for (const [name, file] of files) {
    const value = entries(file).get(key)

    if (value !== undefined)
      rows.push(row(name, key, value, known))
  }

  if (rows.length === 0)
    fail(`${key} is not set in ${file ?? 'any .env* file'}`, 1)

  printRows(rows, parsed.values.json === true, () => console.log(file === undefined ? table(rows.map(each => [role('path', process.stdout)(each.file), each.value])) : rows[0]?.value))

  return 0
}

const grepUsage = `ev grep [-i] <regex> [file...]

Prints the keys matching the regular expression, from the folder's .env* files or the files given, with their values masked as ev list does. The regex is matched against the key only, never the value: \`ev grep '^DATABASE_'\` instead of \`grep ^DATABASE_ .env\`.

--json prints [{file, key, value, secret}].

Exits 0 when a key matches, 1 when none does, 2 on a usage error.`

const showUsage = `ev show <rev>:<file>

Prints every key of an env file as a git revision holds it, values masked as ev list does: \`ev show HEAD~1:api/.env\` instead of \`git show HEAD~1:api/.env\`.

--json prints [{file, key, value, secret}].

Exits 0 when it printed them, 1 when git cannot show the file, 2 on a usage error.`

const REVISION = /^([^:]+):(.+)$/

export async function grep(args: string[]): Promise<number> {
  const parsed = parse(args, grepUsage, { 'ignore-case': { type: 'boolean', short: 'i', description: 'match the key whatever its case' }, ...jsonFlag })

  const [source, ...given] = parsed.positionals

  if (source === undefined)
    fail(`missing the regex\n\n${grepUsage}`)

  let pattern: RegExp

  try {
    pattern = new RegExp(source, parsed.values['ignore-case'] === true ? 'i' : '')
  }
  catch (error) {
    fail(`${source} is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }

  const names = given.length === 0 ? await envFiles() : given
  const rows: Row[] = []

  const { files, known } = await readAll(names)

  for (const [name, file] of files) {
    for (const [key, value] of entries(file)) {
      if (pattern.test(key))
        rows.push(row(name, key, value, known))
    }
  }

  if (rows.length === 0)
    fail(`no key matches ${source} in ${names.join(', ') || 'any .env* file'}`, 1)

  printRows(rows, parsed.values.json === true, () => console.log(table(rows.map(each => [role('path', process.stdout)(each.file), role('value', process.stdout)(each.key), each.value]))))

  return 0
}

export async function show(args: string[]): Promise<number> {
  const parsed = parse(args, showUsage, jsonFlag)

  const [target] = parsed.positionals
  const [, revision, path] = REVISION.exec(target ?? '') ?? []

  if (revision === undefined || path === undefined)
    fail(`give <rev>:<file>\n\n${showUsage}`)

  if (revision.startsWith('-'))
    fail(`${revision} is not a revision: it reads as a git option`)

  const shown = await $`git show --end-of-options ${`${revision}:${path}`}`.quiet().nothrow()

  if (shown.exitCode !== 0)
    fail(`git show ${revision}:${path} failed: ${shown.stderr.toString().trim()}`, 1)

  const file = parseDotenv(shown.stdout.toString())
  const known = await loadKnown(process.cwd(), [file])
  const rows = [...entries(file)].map(([key, value]) => row(target ?? '', key, value, known))

  printRows(rows, parsed.values.json === true, () => {
    if (rows.length > 0)
      console.log(table(rows.map(each => [each.key, each.value])))
  })

  return 0
}
