import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const PACKAGES = new URL('../packages', import.meta.url).pathname
const EXITS = /^Exits (?:0 |with )/m

function run(source: string, args: string[]): string {
  return Bun.spawnSync([process.execPath, source, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } }).stdout.toString()
}

// Every command a bin runs, as the arguments before --help: [] for a single-command bin, a path of names for each leaf of a runCli one.
function commandsOf(source: string, path: string[] = []): string[][] {
  const listed = run(source, ['__complete', ...path, '']).trim().split('\n').map(line => line.slice(0, !line.includes('\t') ? undefined : line.indexOf('\t')))

  if (listed.length === 1 && listed[0] === '__files__')
    return [path]

  return listed.filter(name => name !== '').flatMap(name => commandsOf(source, [...path, name]))
}

const bins = readdirSync(PACKAGES).flatMap((dir) => {
  const manifest = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as { bin?: Record<string, string> }

  return Object.entries(manifest.bin ?? {}).map(([bin, built]) => ({ bin, source: join(PACKAGES, dir, built.replace('./dist/', 'src/').replace('.js', '.ts')) }))
})

describe('every command states its exit codes', () => {
  for (const { bin, source } of bins) {
    test(bin, () => {
      const missing = commandsOf(source).filter(path => !EXITS.test(run(source, [...path, '--help']))).map(path => [bin, ...path].join(' '))

      expect(missing).toEqual([])
    })
  }
})
