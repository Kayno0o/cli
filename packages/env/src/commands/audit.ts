import type { Exposure } from '../audit'
import type { ComposeFix } from '../fix'
import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson } from '@kaynooo/cli-kit'
import { audit as findExposed } from '../audit'
import { fixCompose, shutOthersOut } from '../fix'

const usage = `ev audit [dir...] [--fix]

Lists the .env files any account on the machine can read or git tracks, and the compose files any account can read that write a secret out (a secret-named value or a URL password) instead of reading it from a .env, never printing a value.
Looks under each folder (the current one by default) down to 5 levels, skipping node_modules, vendor and .git, and leaves .example, .sample, .template and .dist files out. A folder it cannot read is named on stderr.
With --fix, moves each secret a listed compose file writes out into the .env beside it as \${KEY}, puts it back when \`docker compose config\` resolves differently after, and shuts other accounts out of both files and of every listed .env; a key the .env already sets to another value stays put.
Exits 0 when it finds none (with --fix, when none is left), 1 when it finds one, 2 on a usage error.`

const options = {
  json: jsonOption('the findings and the folders it could not read'),
  fix: { type: 'boolean', description: 'move inline compose secrets into a .env and shut other accounts out' },
} as const

const SHELL_SAFE = /^[\w./-]+$/
const MAX_UNREAD_LISTED = 3

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
    const open = fix?.open ?? (readable && !await shutOthersOut(path) ? [path] : [])

    if (fix !== undefined)
      fixed.push(fix)

    left ||= tracked || open.length > 0 || (fix?.left.length ?? 0) > 0

    if (json)
      continue

    const lines = [
      ...fix === undefined || fix.moved.length === 0 ? [] : [`moved ${fix.moved.join(', ')} into ${shown(fix.env)}`],
      ...fix?.left.map(({ key, why }) => `left ${key} in place: ${why}`) ?? [],
      ...fix?.check === undefined ? [] : [CHECKS[fix.check]],
      ...open.map(file => `another account owns ${file === path ? 'it' : shown(file)}, so it stays readable: sudo chmod o-rwx ${quoted(shown(file))}`),
      ...readable && !open.includes(path) ? ['now unreadable by other accounts'] : [],
      ...tracked ? [`tracked by git: git rm --cached ${quoted(shown(path))}, then ignore it`] : [],
    ]

    console.log(`${shown(path)}\n  ${lines.join('\n  ')}`)
  }

  return { fixed, left }
}

export async function audit(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const roots = (parsed.positionals.length > 0 ? parsed.positionals : ['.']).map(dir => resolve(dir))

  for (const dir of roots) {
    if (!await isFolder(dir))
      fail(`${dir} is not a folder`)
  }

  const { exposed, unread } = await findExposed(roots)
  const json = parsed.values.json === true

  // Container data folders owned by another account often run to dozens, so past a few they are only counted.
  if (!json && unread.length > MAX_UNREAD_LISTED) {
    console.error(`could not read ${unread.length} folders, so they were not audited (--json lists them)`)
  }
  else if (!json) {
    for (const dir of unread)
      console.error(`could not read ${dir}, so it was not audited`)
  }

  if (parsed.values.fix === true && (json || exposed.length > 0)) {
    const { fixed, left } = await fixAll(exposed, json)

    if (json)
      printJson({ fixed, exposed: (await findExposed(roots)).exposed, unread })

    return left ? 1 : 0
  }

  if (json) {
    printJson({ exposed, unread })

    return exposed.length > 0 ? 1 : 0
  }

  if (exposed.length === 0) {
    console.log('no exposed .env file nor compose file writing a secret out')

    return 0
  }

  const uid = process.getuid?.()

  for (const { path, readable, tracked, secrets } of exposed) {
    // Only the owner or root can change a file's mode.
    const sudo = uid !== undefined && uid !== 0 && (await stat(path)).uid !== uid ? 'sudo ' : ''
    const problems = [
      ...secrets === undefined ? [] : [`writes out ${secrets.join(', ')}: ev audit --fix moves the values into a .env beside it`],
      ...readable ? [`readable by any account: ${sudo}chmod o-rwx ${quoted(shown(path))}`] : [],
      ...tracked ? [`tracked by git: git rm --cached ${quoted(shown(path))}, then ignore it`] : [],
    ]

    console.log(`${shown(path)}\n  ${problems.join('\n  ')}`)
  }

  return 1
}
