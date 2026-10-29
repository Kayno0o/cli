import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, parse } from '@kaynooo/cli-kit'
import { audit as findExposed } from '../audit'

const usage = `ev audit [dir...]

Lists the .env files any account on the machine can read or git tracks, and the compose files any account can read that write a secret out (a secret-named value or a URL password) instead of reading it from a .env, never printing a value.
Looks under each folder (the current one by default) down to 5 levels, skipping node_modules, vendor and .git, and leaves .example, .sample, .template and .dist files out.
Exits 1 when it finds one, 0 otherwise.`

const options = {
  json: { type: 'boolean', description: 'print the findings as JSON' },
} as const

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
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

  const exposed = await findExposed(roots)

  if (parsed.values.json === true) {
    console.log(JSON.stringify(exposed, null, 2))

    return exposed.length > 0 ? 1 : 0
  }

  if (exposed.length === 0) {
    console.log('no exposed .env file nor compose file writing a secret out')

    return 0
  }

  for (const { path, readable, tracked, secrets } of exposed) {
    const shown = path.startsWith(`${process.cwd()}/`) ? relative(process.cwd(), path) : path
    const problems = [
      ...secrets === undefined ? [] : [`writes out ${secrets.join(', ')}: move the values into a .env beside it`],
      ...readable ? [`readable by any account: chmod o-rwx ${shown}`] : [],
      ...tracked ? [`tracked by git: git rm --cached ${shown}, then ignore it`] : [],
    ]

    console.log(`${shown}\n  ${problems.join('\n  ')}`)
  }

  return 1
}
