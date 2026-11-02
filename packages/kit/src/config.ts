import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fail } from './args'

// The nearest of `names` in `from` or a folder above it, the first name winning within one folder; the walk ends after a folder `stop` accepts.
export function findUp(names: string | string[], from = process.cwd(), stop: (dir: string) => boolean = () => false): string | undefined {
  const wanted = typeof names === 'string' ? [names] : names

  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const found = wanted.map(name => join(dir, name)).find(path => existsSync(path))

    if (found !== undefined)
      return found

    if (stop(dir) || dirname(dir) === dir)
      return undefined
  }
}

// A config is looked for up to the repository root or the home folder, never in a folder above them where a stranger's file could sit.
function endsWalk(dir: string): boolean {
  return dir === resolve(homedir()) || existsSync(join(dir, '.git'))
}

export interface ConfigSettings {
  // Where the search starts, the current folder by default.
  from?: string
  // A file named on the command line, read instead of searching; resolved against `from`.
  path?: string | undefined
}

export interface LoadedConfig {
  path: string
  // The folder holding the config, which paths written in it are relative to.
  dir: string
  // Its default export, for the caller to check.
  config: unknown
}

// Imports the nearest config named `names` (`.ts`, `.js` or `.json`) up to the git root or the home folder, or the one `path` names; undefined when none is found. A named file missing, one failing to import or one without a default export ends the command.
export async function loadConfig(names: string | string[], { from = process.cwd(), path }: ConfigSettings = {}): Promise<LoadedConfig | undefined> {
  const file = path === undefined ? findUp(names, from, endsWalk) : resolve(from, path)

  if (file === undefined)
    return undefined

  if (!existsSync(file))
    fail(`no file ${file}`, 1)

  let module: { default?: unknown }

  try {
    module = await import(file) as { default?: unknown }
  }
  catch (error) {
    fail(`${file} does not load: ${error instanceof Error ? error.message : String(error)}`, 1)
  }

  if (module.default === undefined)
    fail(`${file} has no default export`, 1)

  return { path: file, dir: dirname(file), config: module.default }
}
