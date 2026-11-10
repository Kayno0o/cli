import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const transpiler = new Bun.Transpiler({ loader: 'ts' })

interface Manifest { name: string, exports?: Record<string, string>, dependencies?: Record<string, string> }

// The package an import names, `@kaynooo/cli-kit` for `@kaynooo/cli-kit/prompt`.
function packageOf(path: string): string {
  return path.split('/').slice(0, path.startsWith('@') ? 2 : 1).join('/')
}

// The @kaynooo packages the files reachable from an entry import at runtime, type-only imports left out by the transpiler.
function runtimeImports(entry: string): Set<string> {
  const found = new Set<string>()
  const seen = new Set<string>()
  const queue = [entry]

  for (const file of queue) {
    if (seen.has(file) || !existsSync(file))
      continue

    seen.add(file)

    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (path.startsWith('.'))
        queue.push(resolve(dirname(file), path.endsWith('.ts') ? path : `${path}.ts`))
      else if (path.startsWith('@kaynooo/'))
        found.add(packageOf(path))
    }
  }

  return found
}

// A consumer installs only `dependencies`: a package whose library entry reaches a devDependency at runtime fails to load there (`changelog.config.ts` importing @kaynooo/cli-changelog without cli-kit).
test('every @kaynooo package a library export loads at runtime is a dependency', () => {
  const missing = readdirSync(`${ROOT}packages`).flatMap((dir) => {
    const manifestPath = join(ROOT, 'packages', dir, 'package.json')

    if (!existsSync(manifestPath))
      return []

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const entries = Object.entries(manifest.exports ?? {}).filter(([subpath, target]) => subpath !== './test' && target.endsWith('.ts'))

    return entries.flatMap(([subpath, target]) => [...runtimeImports(join(ROOT, 'packages', dir, target))]
      .filter(name => name !== manifest.name && manifest.dependencies?.[name] === undefined)
      .map(name => `${manifest.name} ${subpath} needs ${name}`))
  })

  expect([...new Set(missing)]).toEqual([])
})
