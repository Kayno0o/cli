import { describe, expect, test } from 'bun:test'
import { bins, run } from './bins'

const EXITS = /^Exits (?:0 |with )/m

// Every command a bin runs, as the arguments before --help: [] for a single-command bin, a path of names for each leaf of a runCli one.
function commandsOf(source: string, path: string[] = []): string[][] {
  const listed = run(source, ['__complete', ...path, '']).trim().split('\n').map(line => line.slice(0, !line.includes('\t') ? undefined : line.indexOf('\t')))

  if (listed.length === 1 && listed[0] === '__files__')
    return [path]

  return listed.filter(name => name !== '').flatMap(name => commandsOf(source, [...path, name]))
}

describe('every command states its exit codes', () => {
  for (const { bin, source } of bins) {
    test(bin, () => {
      const missing = commandsOf(source).filter(path => !EXITS.test(run(source, [...path, '--help']))).map(path => [bin, ...path].join(' '))

      expect(missing).toEqual([])
    })
  }
})
