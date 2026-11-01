import { describe, expect, it } from 'bun:test'
import { helpText, parse } from '../src/args'
import { runMain } from '../src/cli'
import { table } from '../src/format'
import { badge, link, marked, paint, role, statusOf } from '../src/style'
import { capture } from '../src/test'
import { stripAnsi } from '../src/text'

const TERMINAL = { isTTY: true }

describe('marked', () => {
  it('draws a coloured symbol on a terminal, and a word anywhere else', () => {
    expect(marked('ok', 'built', TERMINAL, '1.2s', {})).toBe('\x1B[32m✓\x1B[39m built \x1B[2m1.2s\x1B[22m')
    expect(marked('ok', 'built', {}, '1.2s', {})).toBe('ok: built 1.2s')
    expect(marked('warn', 'no alt', {}, undefined, {})).toBe('warning: no alt')
    expect(marked('problem', 'failed', {}, undefined, {})).toBe('error: failed')
    expect(marked('note', 'skipped', {}, undefined, {})).toBe('note: skipped')
  })

  it('prints plain words on a terminal under NO_COLOR', () => {
    expect(marked('ok', 'built', TERMINAL, undefined, { NO_COLOR: '1' })).toBe('ok: built')
  })
})

describe('helpText', () => {
  const options = { times: { type: 'string', short: 'n', description: 'how many' }, loud: { type: 'boolean', description: 'shout' } } as const

  it('lays out the usage and options under their headers, aligned on the visible text', () => {
    expect(helpText('usage: demo greet [options] <name>', options, paint({}))).toBe('Usage: demo greet [options] <name>\n\nOptions:\n  -n, --times <value>  how many\n      --loud           shout')
  })

  it('aligns the same once coloured', () => {
    const coloured = helpText('demo greet [options]', options, paint(TERMINAL, {}))

    expect(coloured).toContain('\x1B[1mUsage:\x1B[22m')
    expect(coloured).toContain('\x1B[36m--loud\x1B[39m')
    expect(stripAnsi(coloured)).toBe('Usage: demo greet [options]\n\nOptions:\n  -n, --times <value>  how many\n      --loud           shout')
  })

  it('names a bad option in a short message, the help left to --help', () => {
    expect(() => parse(['--nope'], 'usage: demo', options)).toThrow('unknown option \'--nope\'')
  })

  it('prints the help through parse on --help', async () => {
    const run = async (args: string[]) => {
      parse(args, 'demo', {})

      return 1
    }

    expect(await capture(async () => runMain({ name: 'demo', version: '1', run }, ['--help']))).toEqual({ result: 0, out: 'Usage: demo\n\nOptions:\n  -h, --help  show this help\n', err: '' })
  })
})

describe('table', () => {
  it('prints the header row as the rest off a terminal', () => {
    expect(table([['name', 'age'], ['ada', '36']], { header: true })).toBe('name  age\nada   36')
  })
})

describe('role and link', () => {
  it('tints by role on a terminal only', () => {
    expect(role('id', TERMINAL, {})('#49')).toBe('\x1B[33m#49\x1B[39m')
    expect(role('id', {}, {})('#49')).toBe('#49')
  })

  it('links with OSC 8 on a terminal, and spells the url out elsewhere', () => {
    expect(link('#49', 'https://x/49', TERMINAL, {})).toBe('\x1B]8;;https://x/49\x1B\\#49\x1B]8;;\x1B\\')
    expect(link('#49', 'https://x/49', {}, {})).toBe('#49 (https://x/49)')
    expect(link('https://x', 'https://x', {}, {})).toBe('https://x')
  })
})

describe('badge', () => {
  it('marks and tints a known status on a terminal, keeping the word it was given', () => {
    expect(badge('success', TERMINAL, {})).toBe('\x1B[32m✓ success\x1B[39m')
    expect(badge('failed', TERMINAL, {})).toBe('\x1B[31m✗ failed\x1B[39m')
    expect(badge('in_progress', TERMINAL, {})).toBe('\x1B[36m● in_progress\x1B[39m')
    expect(badge('waiting', TERMINAL, {})).toBe('\x1B[33m○ waiting\x1B[39m')
    expect(badge('cancelled', TERMINAL, {})).toBe('\x1B[2m- cancelled\x1B[22m')
  })

  it('leaves the word alone off a terminal, and a word of no known status everywhere', () => {
    expect(badge('success', {}, {})).toBe('success')
    expect(badge('mystery', TERMINAL, {})).toBe('mystery')
  })

  it('reads the words CI services use, in any case', () => {
    expect(['Success', 'failure', 'pending', 'canceled', 'running'].map(statusOf)).toEqual(['passed', 'failed', 'queued', 'skipped', 'running'])
  })
})
