import type { Exposure } from '../audit'
import type { ComposeFix } from '../fix'
import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, parse } from '@kaynooo/cli-kit'
import { audit as findExposed } from '../audit'
import { fixCompose, shutOthersOut } from '../fix'

const usage = `ev audit [dir...] [--fix]

Lists the .env files any account on the machine can read or git tracks, and the compose files any account can read that write a secret out (a secret-named value or a URL password) instead of reading it from a .env, never printing a value.
Looks under each folder (the current one by default) down to 5 levels, skipping node_modules, vendor and .git, and leaves .example, .sample, .template and .dist files out. A folder it cannot read is named on stderr.
With --fix, moves each secret a listed compose file writes out into the .env beside it as \${KEY}, puts it back when \`docker compose config\` resolves differently after, and shuts other accounts out of both files and of every listed .env; a key the .env already sets to another value stays put.
Exits 1 when it finds one (with --fix, when one is left), 0 otherwise.`

const options = {
  json: { type: 'boolean', description: 'print the findings and the folders it could not read as JSON' },
  fix: { type: 'boolean', description: 'move inline compose secrets into a .env and shut other accounts out' },
} as const

const SHELL_SAFE = /^[\w./-]+$/

const CHECKS: Record<NonNullable<ComposeFix['check']>, string> = {
  'same': 'docker compose config resolves the same',
  'rolled back': 'docker compose config resolved differently, so everything was put back',
  'no docker': 'not checked against docker compose config: docker is not installed',
  'fails before': 'not checked against docker compose config: it already failed on the file',
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
}

function quoted(path: string): string {
  return SHELL_SAFE.test(path) ? path : `'${path.replaceAll('\'', '\'\\\'\'')}'`
}

function shown(path: string): string {
  return path.startsWith(`${process.cwd()}/`) ? relative(process.cwd(), path) : path
}

// Fixes what it can of each finding and prints what it did, never a value, unless the caller prints JSON.
async function fixAll(exposed: Exposure[], json: boolean): Promise<{ fixed: ComposeFix[], left: boolean }> {
  const fixed: ComposeFix[] = []
  let left = false

  for (const { path, readable, tracked, secrets } of exposed) {
    const fix = secrets === undefined ? undefined : await fixCompose(path)

    if (fix === undefined && readable)
      await shutOthersOut(path)

    if (fix !== undefined)
      fixed.push(fix)

    left ||= tracked || (fix?.left.length ?? 0) > 0

    if (json)
      continue

    const lines = [
      ...fix === undefined || fix.moved.length === 0 ? [] : [`moved ${fix.moved.join(', ')} into ${shown(fix.env)}`],
      ...fix?.left.map(({ key, why }) => `left ${key} in place: ${why}`) ?? [],
      ...fix?.check === undefined ? [] : [CHECKS[fix.check]],
      ...readable ? ['now unreadable by other accounts'] : [],
      ...tracked ? [`tracked by git: git rm --cached ${quoted(shown(path))}, then ignore it`] : [],
    ]

    console.log(`${shown(path)}\n  ${lines.join('\n  ')}`)
  }

  return { fixed, left }
}

export async function audit(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const roots = (parsed.positionals.length > 0 ? parsed.positionals : ['.']).map(dir => resolve(dir))

  for (const dir of roots) {
    if (!await isFolder(dir))
      fail(`${dir} is not a folder`)
  }

  const { exposed, unread } = await findExposed(roots)
  const json = parsed.values.json === true

  if (!json) {
    for (const dir of unread)
      console.error(`could not read ${dir}, so it was not audited`)
  }

  if (parsed.values.fix === true && (json || exposed.length > 0)) {
    const { fixed, left } = await fixAll(exposed, json)

    if (json)
      console.log(JSON.stringify({ fixed, exposed: (await findExposed(roots)).exposed, unread }, null, 2))

    return left ? 1 : 0
  }

  if (json) {
    console.log(JSON.stringify({ exposed, unread }, null, 2))

    return exposed.length > 0 ? 1 : 0
  }

  if (exposed.length === 0) {
    console.log('no exposed .env file nor compose file writing a secret out')

    return 0
  }

  for (const { path, readable, tracked, secrets } of exposed) {
    const problems = [
      ...secrets === undefined ? [] : [`writes out ${secrets.join(', ')}: move the values into a .env beside it`],
      ...readable ? [`readable by any account: chmod o-rwx ${quoted(shown(path))}`] : [],
      ...tracked ? [`tracked by git: git rm --cached ${quoted(shown(path))}, then ignore it`] : [],
    ]

    console.log(`${shown(path)}\n  ${problems.join('\n  ')}`)
  }

  return 1
}
