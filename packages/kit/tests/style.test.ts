import { describe, expect, it } from 'bun:test'
import { helpText, parse } from '../src/args'
import { bar } from '../src/chart'
import { runMain } from '../src/cli'
import { table } from '../src/format'
import { badge, header, link, marked, paint, role, statusOf } from '../src/style'
import { capture } from '../src/test'
import { stripAnsi } from '../src/text'

const TERMINAL = { isTTY: true }

describe('marked', () => {
  it('draws a coloured symbol on a terminal, and a word anywhere else', () => {
    expect(marked('ok', 'built', TERMINAL, '1.2s', {})).toBe('\x1B[1m\x1B[32m✓\x1B[39m\x1B[22m built \x1B[2m1.2s\x1B[22m')
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

    expect(await capture(async () => runMain({ name: 'demo', version: '1', run }, ['--help']))).toEqual({ result: 0, out: 'Usage: demo\n\nOptions:\n      --color <value>  auto (on a terminal alone), always or never\n      --plain          plain text, no colour or spinner: --color never\n  -h, --help           show this help\n', err: '' })
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

describe('header', () => {
  it('names the bin in its own accent on a terminal, and is empty elsewhere', () => {
    expect(header('check', 'cli', TERMINAL, {})).toBe('\x1B[1m\x1B[36mcheck\x1B[39m\x1B[22m\x1B[2m › cli\x1B[22m')
    expect(header('check', 'cli', {}, {})).toBe('')
    expect(header('check', 'cli', TERMINAL, { NO_COLOR: '1' })).toBe('')
  })

  it('gives a bin the same accent every time', () => {
    expect(header('ft', undefined, TERMINAL, {})).toBe(header('ft', undefined, TERMINAL, {}))
  })
})

describe('header accents', () => {
  it('gives different bins different accents, each stable', () => {
    const accents = ['check', 'ft', 'pick', 'db', 'doctor', 'wait'].map(bin => header(bin, undefined, TERMINAL, {}))

    expect(new Set(accents).size).toBeGreaterThan(2)
    expect(header('ft', undefined, TERMINAL, {})).toBe(accents[1]!)
  })
})

describe('a slot state as a badge', () => {
  it('reads holding as running and waiting as queued', () => {
    expect(badge('holding', TERMINAL, {})).toBe('\x1B[36m● holding\x1B[39m')
    expect(badge('waiting', TERMINAL, {})).toBe('\x1B[33m○ waiting\x1B[39m')
    expect(badge('holding', {}, {})).toBe('holding')
  })
})

describe('table for an agent', () => {
  it('joins cells with a tab, no padding, rule or colour', () => {
    const rows = [['bin', 'runs'], ['\x1B[33mcheck\x1B[39m', '12'], ['ft', '1042']]

    expect(table(rows, { header: true, stream: TERMINAL, env: { CLAUDECODE: '1' } })).toBe('bin\truns\ncheck\t12\nft\t1042')
    expect(table(rows, { align: ['left', 'right'], env: { KIT_MODE: 'agent' } })).toBe('bin\truns\ncheck\t12\nft\t1042')
  })
})

describe('table header rule', () => {
  const rows = [['bin', 'runs'], ['check', '12']]

  it('draws a dim rule under a bold header on a terminal', () => {
    expect(table(rows, { header: true, stream: TERMINAL })).toBe('\x1B[1mbin    runs\x1B[22m\n\x1B[2m───────────\x1B[22m\ncheck  12')
  })

  it('draws nothing more off a terminal', () => {
    expect(table(rows, { header: true, stream: {} })).toBe('bin    runs\ncheck  12')
  })
})

// Runs `run` with KIT_THEME set, and puts the variable back whatever happens.
function withTheme(name: string, run: () => void): void {
  const before = process.env.KIT_THEME

  process.env.KIT_THEME = name

  try {
    run()
  }
  finally {
    if (before === undefined)
      delete process.env.KIT_THEME
    else
      process.env.KIT_THEME = before
  }
}

describe('a theme in force', () => {
  it('redraws marks, badges, bars and roles on a terminal', () => {
    withTheme('ascii', () => {
      expect(badge('success', TERMINAL, {})).toBe('\x1B[32m+ success\x1B[39m')
      expect(marked('problem', 'broke', TERMINAL, undefined, {})).toBe('\x1B[1m\x1B[31mx\x1B[39m\x1B[22m broke')
      expect(bar(0.5, { stream: TERMINAL, env: {}, width: 4 })).toBe('\x1B[36m##\x1B[39m\x1B[2m##\x1B[22m')
    })

    expect(badge('success', TERMINAL, {})).toBe('\x1B[32m✓ success\x1B[39m')
  })

  it('changes nothing off a terminal or under NO_COLOR', () => {
    withTheme('ascii', () => {
      expect(badge('success', {}, {})).toBe('success')
      expect(marked('ok', 'built', {}, undefined, {})).toBe('ok: built')
      expect(bar(0.5, { stream: {}, env: {}, width: 4 })).toBe('━━──')
      expect(role('accent', TERMINAL, { NO_COLOR: '1' })('x')).toBe('x')
      expect(header('ft', undefined, TERMINAL, { NO_COLOR: '1' })).toBe('')
    })
  })

  it('draws a bin with the colour the theme gives it, bold once', () => {
    withTheme('mono', () => {
      expect(header('ft', undefined, TERMINAL, {})).toBe('\x1B[1mft\x1B[22m')
    })
  })
})
