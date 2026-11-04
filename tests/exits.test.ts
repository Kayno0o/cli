import { describe, expect, test } from 'bun:test'
import { bins, run } from './bins'

// The exit table of packages/kit/README.md: 0 clean, 1 a finding / nothing found / an operation that ran and failed, 2 a usage error or could not check; a bin running another command may also answer with its code (126, 127, 128 + a signal).
const TABLE = new Set([0, 1, 2, 126, 127])
const STATES_EXITS = /^Exits(?::| (?:0 |with ))/m
const EXITS_TEXT = /^Exits(?::| ).*(?:\n.+)*/m
const CODE = /(?<![\w-])(\d{1,3})(?= [a-z]|,| {2})/g
const UNKNOWN_OPTION = '--no-such-option-for-the-exit-test'

// Bins whose commands hand the arguments to another program, which answers the unknown option.
const PASS_THROUGH = new Set(['dc', 'dx', 'sf'])

interface Leaf {
  path: string[]
  help: string
}

// Every command a bin runs, as the arguments before --help: [] for a single-command bin, a path of names for each leaf of a runCli one.
function commandsOf(source: string, path: string[] = []): string[][] {
  const listed = run(source, ['__complete', ...path, '']).trim().split('\n').map(line => line.slice(0, !line.includes('\t') ? undefined : line.indexOf('\t')))

  if (listed.length === 1 && listed[0] === '__files__')
    return [path]

  return listed.filter(name => name !== '').flatMap(name => commandsOf(source, [...path, name]))
}

function exitedWith(source: string, args: string[]): number {
  return Bun.spawnSync([process.execPath, source, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1', KAYNOOO_CLI_NO_USAGE: '1' } }).exitCode
}

describe('every command states its exit codes', () => {
  for (const { bin, source } of bins) {
    const leaves: Leaf[] = commandsOf(source).map(path => ({ path, help: run(source, [...path, '--help']) }))

    test(`${bin} states them in its help`, () => {
      expect(leaves.filter(({ help }) => !STATES_EXITS.test(help)).map(({ path }) => [bin, ...path].join(' '))).toEqual([])
    })

    test(`${bin} states only codes of the table, and 2 for a usage error`, () => {
      const wrong = leaves.flatMap(({ path, help }) => {
        const text = EXITS_TEXT.exec(help)?.[0] ?? ''
        const codes = [...text.matchAll(CODE)].map(match => Number(match[1]))
        const outside = codes.filter(code => !TABLE.has(code) && code < 128)
        const missing = (/usage error/).test(text) && !codes.includes(2) ? ['no 2 for the usage error'] : []

        return [...outside.map(code => `${code} is not in the table`), ...missing].map(why => `${[bin, ...path].join(' ')}: ${why}`)
      })

      expect(wrong).toEqual([])
    })

    test(`${bin} answers --help with 0 and an unknown option with 2`, () => {
      const wrong = leaves.flatMap(({ path }) => {
        const name = [bin, ...path].join(' ')
        const answered = [exitedWith(source, [...path, '--help']), PASS_THROUGH.has(bin) ? 2 : exitedWith(source, [...path, UNKNOWN_OPTION])]

        return answered[0] === 0 && answered[1] === 2 ? [] : [`${name}: --help ${answered[0]}, unknown option ${answered[1]}`]
      })

      expect(wrong).toEqual([])
    })
  }
})
