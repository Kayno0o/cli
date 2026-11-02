import type { AppPins } from '../pins'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fail, jsonOption, ok, parse, printJson } from '@kaynooo/cli-kit'
import { checkApp } from '../pins'

const usage = `ev pins [dir] [--except NAME,...]

Checks that an app's tests pin the env that reaches outside.
Reads the app's env schema (the file calling defineEnv, src/env.ts) and lists its optional URL, key, token, secret, password and host variables, then the ones no \`.env.test\` entry, test-level overrideEnv or local bunfig preload dropping what .env sets pins, and each test file that calls testSite or proxyKeyTests without pinning them all.
A file whose pages reach none of them says so with a \`// ev pins: none reached, <why>\` comment.
The dir is an app, or a monorepo holding apps one level down (the current folder by default).
Reads variable names only, never a value.
Exits 0 when everything is pinned, 1 when something is not, 2 on a usage error.`

const options = {
  json: jsonOption('each app with its reaching, unpinned variables and flagged test files'),
  except: { type: 'string', description: 'comma-separated variables to leave out, as ones that only link back to the app' },
} as const

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
}

async function apps(dir: string, except: ReadonlySet<string>): Promise<AppPins[]> {
  const own = await checkApp(dir, except)

  if (own !== undefined)
    return [own]

  const found: AppPins[] = []

  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
      continue

    const app = await checkApp(join(dir, entry.name), except)

    if (app !== undefined)
      found.push(app)
  }

  return found
}

function failing(app: AppPins): boolean {
  return app.unpinned.length > 0 || app.files.length > 0
}

function name(app: AppPins, root: string): string {
  return app.app === root ? app.app.split('/').at(-1) ?? app.app : app.app.slice(root.length + 1)
}

export async function pins(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { positionals: ['[dir]'] })
  const json = parsed.values.json === true
  const root = resolve(parsed.positionals[0] ?? '.')
  const except = new Set((parsed.values.except ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== ''))

  if (!await isFolder(root))
    fail(`${root} is not a folder`)

  const found = await apps(root, except)

  if (found.length === 0)
    fail(`no env schema (a defineEnv call in src/env.ts) in ${root} or its folders`)

  if (json) {
    printJson(found.map(app => ({ ...app, app: name(app, root) })))

    return found.some(failing) ? 1 : 0
  }

  for (const app of found) {
    const label = name(app, root)

    if (!failing(app)) {
      ok(label, app.preload === undefined ? `${app.reaching.length} reaching variables pinned` : `every variable pinned by ${app.preload}`)

      continue
    }

    console.log(`${label}: ${app.reaching.length} optional variables reach outside`)

    if (app.unpinned.length > 0)
      console.log(`  unpinned by .env.test or any overrideEnv: ${app.unpinned.join(', ')}`)

    for (const { file, unpinned } of app.files)
      console.log(`  ${file} renders a page without pinning: ${unpinned.join(', ')}`)
  }

  return found.some(failing) ? 1 : 0
}
