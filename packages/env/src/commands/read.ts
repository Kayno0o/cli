import type { ExitRow } from '@kaynooo/cli-kit'
import type { KnownSecrets } from '../mask'
import { fail, jsonOption, parse, printJson, role, table } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { entries, parseDotenv } from '../dotenv'
import { assertDotenvText, assertReadableName, envFiles, loadKnown, readEntries } from '../files'
import { isSecretKey, maskValue } from '../mask'
import { parseStructured, structuredFormat } from '../structured'

const listUsage = `ev list [file]

Prints every key of the folder's .env* files, or of one file, with secret values masked to a few leading characters and the length. A JSON, YAML or TOML file names its keys as dotted paths (\`database.password\`, \`servers.0.host\`).

--json prints [{file, key, value, secret}], value masked and secret true when a value was.`

const LIST_EXITS: ExitRow[] = [[0, 'it printed them'], [1, 'there is no .env* file'], [2, 'a usage error']]

const getUsage = `ev get KEY [file]

Prints the masked value of one key, from every .env* file that sets it or from one file: \`ev get database.password config.yaml\`.

--json prints [{file, key, value, secret}] for each file that sets it.`

const GET_EXITS: ExitRow[] = [[0, 'the key is set'], [1, 'it is not set anywhere'], [2, 'a usage error']]

export function display(key: string, value: string, known?: KnownSecrets): string {
  return maskValue(key, value, known).replaceAll('\n', '\\n').replaceAll('\r', '\\r')
}

const jsonFlag = { json: jsonOption() } as const

interface Row { file: string, key: string, value: string, secret: boolean }

// A row per key with its file name in the path colour and the key bold on a terminal.
function keyTable(rows: Row[]): string {
  const path = role('path', process.stdout)
  const key = role('value', process.stdout)

  return table(rows.map(each => [path(each.file), key(each.key), each.value]))
}

function fileTable(rows: Row[]): string {
  const path = role('path', process.stdout)

  return table(rows.map(each => [path(each.file), each.value]))
}

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
async function readAll(names: string[], scanned: boolean): Promise<{ files: [name: string, keys: Map<string, string>][], known: KnownSecrets }> {
  const files: [string, Map<string, string>][] = []

  for (const name of names)
    files.push([name, await readEntries(name, { scanned })])

  return { files, known: await loadKnown(process.cwd(), files.map(([, file]) => file)) }
}

export async function list(args: string[]): Promise<number> {
  const parsed = parse(args, listUsage, jsonFlag, { exits: LIST_EXITS })

  const [file] = parsed.positionals
  const names = file === undefined ? await envFiles() : [file]

  if (names.length === 0)
    fail('no .env* file in this folder', 1)

  const rows: Row[] = []

  const { files, known } = await readAll(names, file === undefined)

  for (const [name, keys] of files) {
    for (const [key, value] of keys)
      rows.push(row(name, key, value, known))
  }

  printRows(rows, parsed.values.json === true, () => {
    if (rows.length > 0)
      console.log(keyTable(rows))
  })

  return 0
}

export async function get(args: string[]): Promise<number> {
  const parsed = parse(args, getUsage, jsonFlag, { exits: GET_EXITS })

  const [key, file] = parsed.positionals

  if (key === undefined)
    fail(`missing KEY\n\n${getUsage}`)

  const names = file === undefined ? await envFiles() : [file]
  const rows: Row[] = []

  const { files, known } = await readAll(names, file === undefined)

  for (const [name, keys] of files) {
    const value = keys.get(key)

    if (value !== undefined)
      rows.push(row(name, key, value, known))
  }

  if (rows.length === 0)
    fail(`${key} is not set in ${file ?? 'any .env* file'}`, 1)

  printRows(rows, parsed.values.json === true, () => console.log(file === undefined ? fileTable(rows) : rows[0]?.value))

  return 0
}

const grepUsage = `ev grep [-i] <regex> [file...]

Prints the keys matching the regular expression, from the folder's .env* files or the files given, with their values masked as ev list does. The regex is matched against the key only, never the value: \`ev grep '^DATABASE_'\` instead of \`grep ^DATABASE_ .env\`.

--json prints [{file, key, value, secret}].`

const GREP_EXITS: ExitRow[] = [[0, 'a key matches'], [1, 'none does'], [2, 'a usage error']]

const showUsage = `ev show <rev>:<file>

Prints every key of an env file as a git revision holds it, values masked as ev list does: \`ev show HEAD~1:api/.env\` instead of \`git show HEAD~1:api/.env\`.

--json prints [{file, key, value, secret}].`

const SHOW_EXITS: ExitRow[] = [[0, 'it printed them'], [1, 'git cannot show the file'], [2, 'a usage error']]

const REVISION = /^([^:]+):(.+)$/

export async function grep(args: string[]): Promise<number> {
  const parsed = parse(args, grepUsage, { 'ignore-case': { type: 'boolean', short: 'i', description: 'match the key whatever its case' }, ...jsonFlag }, { exits: GREP_EXITS })

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

  const { files, known } = await readAll(names, given.length === 0)

  for (const [name, keys] of files) {
    for (const [key, value] of keys) {
      if (pattern.test(key))
        rows.push(row(name, key, value, known))
    }
  }

  if (rows.length === 0)
    fail(`no key matches ${source} in ${names.join(', ') || 'any .env* file'}`, 1)

  printRows(rows, parsed.values.json === true, () => console.log(keyTable(rows)))

  return 0
}

function dotenvKeys(name: string, text: string, redact: string): Map<string, string> {
  const file = parseDotenv(text)

  assertDotenvText(name, file, redact)

  return entries(file)
}

export async function show(args: string[]): Promise<number> {
  const parsed = parse(args, showUsage, jsonFlag, { exits: SHOW_EXITS })

  const [target] = parsed.positionals
  const [, revision, path] = REVISION.exec(target ?? '') ?? []

  if (revision === undefined || path === undefined)
    fail(`give <rev>:<file>\n\n${showUsage}`)

  if (revision.startsWith('-'))
    fail(`${revision} is not a revision: it reads as a git option`)

  const redact = `git show ${revision}:${path} | ev redact`

  assertReadableName(path, redact)

  const shown = await $`git show --end-of-options ${`${revision}:${path}`}`.quiet().nothrow()

  if (shown.exitCode !== 0)
    fail(`git show ${revision}:${path} failed: ${shown.stderr.toString().trim()}`, 1)

  const keys = structuredFormat(path) === undefined ? dotenvKeys(target ?? '', shown.stdout.toString(), redact) : parseStructured(target ?? '', shown.stdout.toString())
  const known = await loadKnown(process.cwd(), [keys])
  const rows = [...keys].map(([key, value]) => row(target ?? '', key, value, known))

  printRows(rows, parsed.values.json === true, () => {
    if (rows.length > 0)
      console.log(table(rows.map(each => [each.key, each.value])))
  })

  return 0
}
