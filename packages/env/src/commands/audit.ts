import type { ExitRow } from '@kaynooo/cli-kit'
import type { Exposure } from '../audit'
import type { ComposeFix } from '../fix'
import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, role, warn } from '@kaynooo/cli-kit'
import { shellQuote } from '@kaynooo/cli-kit/shell'
import { audit as findExposed } from '../audit'
import { fixCompose, shutOthersOut } from '../fix'

const usage = `ev audit [dir...] [--fix]: lists the .env files any account can read or git tracks and the compose files writing a secret out, never printing a value

It looks under each folder (the current one by default) down to 5 levels, skipping \`node_modules\`, \`vendor\` and \`.git\`, and leaves \`.example\`, \`.sample\`, \`.template\` and \`.dist\` files out.
With --fix, each secret a listed compose file writes out moves into the .env beside it as \`\${KEY}\` and goes back when \`docker compose config\` resolves differently after; a key the .env already sets to another value stays put.`

const EXITS: ExitRow[] = [[0, 'it finds none (with --fix, when none is left)'], [1, 'it finds one'], [2, 'a usage error']]

const options = {
  json: jsonOption('the findings and the folders it could not read'),
  fix: { type: 'boolean', description: 'move inline compose secrets into a .env and shut other accounts out' },
} as const

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

function shown(path: string): string {
  return path.startsWith(`${process.cwd()}/`) ? relative(process.cwd(), path) : path
}

// Fixes what it can of each finding and prints what it did, never a value, unless the caller prints JSON.
async function fixAll(exposed: Exposure[], json: boolean): Promise<{ fixed: ComposeFix[], left: boolean }> {
  const fixed: ComposeFix[] = []
  let left = false
  const tint = role('path', process.stdout)

  for (const { path, readable, group, tracked, secrets } of exposed) {
    const fix = secrets === undefined ? undefined : await fixCompose(path, group === true)
    const open = fix?.open ?? (readable && !await shutOthersOut(path, group === true) ? [path] : [])

    if (fix !== undefined)
      fixed.push(fix)

    left ||= tracked || open.length > 0 || (fix?.left.length ?? 0) > 0

    if (json)
      continue

    const lines = [
      ...fix === undefined || fix.moved.length === 0 ? [] : [`moved ${fix.moved.join(', ')} into ${shown(fix.env)}`],
      ...fix?.left.map(({ key, why }) => `left ${key} in place: ${why}`) ?? [],
      ...fix?.check === undefined ? [] : [CHECKS[fix.check]],
      ...open.map(file => `another account owns ${file === path ? 'it' : shown(file)}, so it stays readable: sudo chmod go-rwx ${shellQuote(shown(file))}`),
      ...readable && !open.includes(path) ? ['now unreadable by other accounts'] : [],
      ...tracked ? [`tracked by git: git rm --cached ${shellQuote(shown(path))}, then ignore it`] : [],
    ]

    console.log(`${tint(shown(path))}\n  ${lines.join('\n  ')}`)
  }

  return { fixed, left }
}

export async function audit(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS })

  const roots = (parsed.positionals.length > 0 ? parsed.positionals : ['.']).map(dir => resolve(dir))

  for (const dir of roots) {
    if (!await isFolder(dir))
      fail(`${dir} is not a folder`)
  }

  const { exposed, unread } = await findExposed(roots)
  const json = parsed.values.json === true

  // Container data folders owned by another account often run to dozens, so past a few they are only counted.
  if (!json && unread.length > MAX_UNREAD_LISTED) {
    warn(`could not read ${unread.length} folders, so they were not audited (--json lists them)`)
  }
  else if (!json) {
    for (const dir of unread)
      warn(`could not read ${dir}, so it was not audited`)
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
  const tint = role('path', process.stdout)

  for (const { path, readable, group, tracked, secrets } of exposed) {
    // Only the owner or root can change a file's mode.
    const sudo = uid !== undefined && uid !== 0 && (await stat(path)).uid !== uid ? 'sudo ' : ''
    const problems = [
      ...secrets === undefined ? [] : [`writes out ${secrets.join(', ')}: ev audit --fix moves the values into a .env beside it`],
      ...readable ? [group === true ? `readable by its group or an ACL: ${sudo}chmod go-rwx ${shellQuote(shown(path))}` : `readable by any account: ${sudo}chmod o-rwx ${shellQuote(shown(path))}`] : [],
      ...tracked ? [`tracked by git: git rm --cached ${shellQuote(shown(path))}, then ignore it`] : [],
    ]

    console.log(`${tint(shown(path))}\n  ${problems.join('\n  ')}`)
  }

  return 1
}
