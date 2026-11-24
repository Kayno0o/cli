import { describe, expect, test } from 'bun:test'
import { bins } from './bins'

// The exit table of packages/kit/README.md: 0 clean, 1 a finding / nothing found / an operation that ran and failed, 2 a usage error or could not check; a bin running another command may also answer with its code (125, 126, 127, 128 + a signal), 125 being git bisect run's "cannot test".
const TABLE = new Set([0, 1, 2, 125, 126, 127])
const STATES_EXITS = /^(?:Exits(?::| (?:0 |with ))|Exit codes:)/m
const EXITS_TEXT = /^(?:Exits(?::| )|Exit codes: ).*(?:\n.+)*/m
const CODE = /(?<![\w-])(\d{1,3})(?= [a-z]|,| {2})/g
const UNKNOWN_OPTION = '--no-such-option-for-the-exit-test'
// Processes alive at once: enough to keep this file off the suite's critical path, few enough to leave the other test workers their CPUs.
const SPAWNS = 8

// Bins whose commands hand the arguments to another program, which answers the unknown option.
const PASS_THROUGH = new Set(['dc', 'dx', 'sf'])
// Every `runCli` group help ends on `Run <prefix> <command> --help for its options.`; a leaf command never does.
const GROUP_HELP = /<command> --help for its options\./

interface Answer {
  out: string
  code: number
}

interface Leaf {
  path: string[]
  help: Answer
  unknown: number
}

let running = 0
const waiting: (() => void)[] = []

async function answer(source: string, args: string[]): Promise<Answer> {
  if (running >= SPAWNS)
    await new Promise<void>(resolve => waiting.push(resolve))

  running++

  try {
    const proc = Bun.spawn([process.execPath, source, ...args], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, NO_COLOR: '1', KAYNOOO_CLI_NO_USAGE: '1' } })
    const [out, code] = await Promise.all([proc.stdout.text(), proc.exited])

    return { out, code }
  }
  finally {
    running--
    waiting.shift()?.()
  }
}

// Every leaf command a bin runs, walking only groups (whose --help lists subcommands) so positional candidates of a leaf are never mistaken for subcommands.
async function leavesOf(bin: string, source: string, path: string[] = []): Promise<Leaf[]> {
  const help = await answer(source, [...path, '--help'])

  if (!GROUP_HELP.test(help.out)) {
    const unknown = PASS_THROUGH.has(bin) ? 2 : (await answer(source, [...path, UNKNOWN_OPTION])).code

    return [{ path, help, unknown }]
  }

  // Only the subcommands listed under headings in the group's --help (leaving out a default command's dynamic positional candidates).
  const listed = (await answer(source, ['__complete', ...path, ''])).out.trim().split('\n').map(line => line.slice(0, !line.includes('\t') ? undefined : line.indexOf('\t')))
  const subcommands = new Set([...help.out.matchAll(/^ {2}([a-z0-9][a-z0-9-]*) {2}/gm)].map(match => match[1]!))
  const names = listed.filter(name => subcommands.has(name))

  return (await Promise.all(names.map(async name => leavesOf(bin, source, [...path, name])))).flat()
}

// Asked up front and all at once, as one spawn after the other made this file the longest of the suite.
const answered = await Promise.all(bins.map(async ({ bin, source }) => ({ bin, leaves: await leavesOf(bin, source) })))

describe('every command states its exit codes', () => {
  for (const { bin, leaves } of answered) {
    test(`${bin} states them in its help`, () => {
      expect(leaves.filter(({ help }) => !STATES_EXITS.test(help.out)).map(({ path }) => [bin, ...path].join(' '))).toEqual([])
    })

    test(`${bin} states only codes of the table, and 2 for a usage error`, () => {
      const wrong = leaves.flatMap(({ path, help }) => {
        const text = EXITS_TEXT.exec(help.out)?.[0] ?? ''
        const codes = [...text.matchAll(CODE)].map(match => Number(match[1]))
        const outside = codes.filter(code => !TABLE.has(code) && code < 128)
        const missing = (/usage error/).test(text) && !codes.includes(2) ? ['no 2 for the usage error'] : []

        return [...outside.map(code => `${code} is not in the table`), ...missing].map(why => `${[bin, ...path].join(' ')}: ${why}`)
      })

      expect(wrong).toEqual([])
    })

    test(`${bin} answers --help with 0 and an unknown option with 2`, () => {
      const wrong = leaves.flatMap(({ path, help, unknown }) => help.code === 0 && unknown === 2 ? [] : [`${[bin, ...path].join(' ')}: --help ${help.code}, unknown option ${unknown}`])

      expect(wrong).toEqual([])
    })
  }
})
