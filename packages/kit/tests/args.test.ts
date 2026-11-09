import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { description, duration, Exit, HelpShown, jsonOption, oneOf, optionRows, paint, parse, readInput, UsageError, wholeNumber } from '../src'
import { capture, tempDirs } from '../src/test'

const temp = tempDirs()

const options = { lines: { type: 'string', short: 'n', description: 'lines' } } as const

describe('parse', () => {
  test('leaves a `--` to node:util unless asked to pass it through', () => {
    expect(parse(['-n', '5', '--', 'a'], 'u', options)).toMatchObject({ values: { lines: '5' }, positionals: ['a'], rest: undefined })
  })

  test('hands what follows `--` back untouched, options included', () => {
    expect(parse(['-n', '5', 'x', '--', 'ls', '-n', '--help'], 'u', options, { rest: true })).toMatchObject({ values: { lines: '5' }, positionals: ['x'], rest: ['ls', '-n', '--help'] })
    expect(parse(['-n', '5'], 'u', options, { rest: true }).rest).toBeUndefined()
  })

  test('takes a string option\'s value starting with a dash, unless it names an option', () => {
    const edit = { from: { type: 'string', short: 'f', description: 'from' }, all: { type: 'boolean', description: 'all' } } as const

    expect(parse(['--from', '- item', '-f', '-x', 'a.md'], 'u', { ...edit, from: { ...edit.from, multiple: true } })).toMatchObject({ values: { from: ['- item', '-x'] }, positionals: ['a.md'] })
    expect(parse(['-n', '-3'], 'u', options).values.lines).toBe('-3')
    expect(() => parse(['--from', '--all'], 'u', edit)).toThrow(UsageError)
    expect(parse(['--', '--from', '-x'], 'u', edit).positionals).toEqual(['--from', '-x'])
  })

  test('takes `--no-<flag>` as false only when asked to', () => {
    const flags = { emoji: { type: 'boolean', default: true, description: 'emoji' } } as const

    expect(parse(['--no-emoji'], 'u', flags, { allowNegative: true }).values.emoji).toBe(false)
    expect(parse([], 'u', flags, { allowNegative: true }).values.emoji).toBe(true)
    expect(() => parse(['--no-emoji'], 'u', flags)).toThrow(Exit)
  })

  test('hints the nearest option on an unknown one, none when nothing is close', () => {
    const flags = { check: { type: 'boolean', short: 'c' }, times: { type: 'string', short: 't', description: 'times' } } as const
    const hint = (args: string[], negative = false) => {
      try {
        parse(args, 'u', flags, { allowNegative: negative })
      }
      catch (error) {
        return error instanceof UsageError ? error.hint : 'not a usage error'
      }

      return 'no error'
    }

    expect(hint(['--chek'])).toBe('did you mean --check?')
    expect(hint(['--chek=1'])).toBe('did you mean --check?')
    expect(hint(['--no-chek'], true)).toBe('did you mean --no-check?')
    expect(hint(['--no-chek'])).toBeUndefined()
    expect(hint(['--no-times'], true)).toBeUndefined()
    expect(hint(['--tim'])).toBe('did you mean --times?')
    expect(hint(['--c'])).toBe('did you mean -c?')
    expect(hint(['-x'])).toBeUndefined()
    expect(hint(['--zzzzzz'])).toBeUndefined()
  })

  test('prints an option without a description as its flag alone', () => {
    const rows = optionRows({ bare: { type: 'boolean' }, said: { type: 'string', description: 'said' } }, paint({ isTTY: false }))

    expect(rows[0]).toBe('      --bare')
    expect(rows[1]).toBe('      --said <value>  said')
  })

  test('throws HelpShown after printing the help, so the command goes no further', async () => {
    const { out } = await capture(async () => {
      expect(() => parse(['--help'], 'u', options)).toThrow(HelpShown)

      return 0
    })

    expect(out).toStartWith('Usage: u')
  })

  test('takes the positionals named, a missing or an extra one a usage error', () => {
    const [key, file] = parse(['K', 'x.env'], 'u', {}, { positionals: ['<key>', '[file]'] }).positionals

    expect([key, file]).toEqual(['K', 'x.env'])
    expect(parse(['K'], 'u', {}, { positionals: ['KEY', '[file]'] }).positionals).toEqual(['K'])
    expect(() => parse([], 'u', {}, { positionals: ['<key>', '[file]'] })).toThrow(new UsageError('missing <key>'))
    expect(() => parse(['a', 'b', 'c'], 'u', {}, { positionals: ['<key>', '[file]'] })).toThrow(new UsageError('unexpected argument c'))
    expect(() => parse(['foo'], 'u', {}, { positionals: [] })).toThrow(new UsageError('unexpected argument foo'))
  })

  test('takes any number past a last name ending in ..., at least one when it is required', () => {
    expect(parse(['a', 'b', 'c'], 'u', {}, { positionals: ['<out>', '[paths...]'] }).positionals).toEqual(['a', 'b', 'c'])
    expect(parse([], 'u', {}, { positionals: ['[paths...]'] }).positionals).toEqual([])
    expect(() => parse([], 'u', {}, { positionals: ['<paths...>'] })).toThrow(new UsageError('missing <paths...>'))
  })

  test('keeps a negative number a usage error, read as an option', () => {
    expect(() => parse(['-1'], 'u', {}, { positionals: ['[n]'] })).toThrow(UsageError)
  })

  test('types the positionals by their names', () => {
    const { positionals } = parse(['K'], 'u', {}, { positionals: ['<key>', '[file]', '[more...]'] })
    const key: string = positionals[0]
    const file: string | undefined = positionals[1]
    const [, , ...more] = positionals

    expect([key, file, more]).toEqual(['K', undefined, []])
  })
})

describe('readInput', () => {
  test('reads a file', async () => {
    const path = join(temp('kit-'), 'in.txt')

    writeFileSync(path, 'hello\n')
    expect(await readInput(path)).toBe('hello\n')
  })

  test('refuses a missing file', async () => {
    expect(readInput('/no/such/file')).rejects.toThrow(new Exit('no file /no/such/file', 2))
  })
})

describe('duration', () => {
  test('reads a unit, or the default unit on a bare number', () => {
    expect(duration('500ms', 't', 0)).toBe(500)
    expect(duration('1.5s', 't', 0)).toBe(1500)
    expect(duration('90', 't', 0)).toBe(90_000)
    expect(duration('15', 't', 0, 'm')).toBe(900_000)
    expect(duration('1h', 't', 0, 'm')).toBe(3_600_000)
    expect(duration(undefined, 't', 42)).toBe(42)
  })

  test('refuses anything else', () => {
    expect(() => duration('5 min', 'timeout', 0)).toThrow(new Exit('--timeout takes a duration such as 30s, 5m, 1h or 7d, not 5 min', 2))
    expect(() => duration('0', 'timeout', 0)).toThrow(Exit)
  })
})

describe('choices', () => {
  const bump = { bump: { type: 'string', description: 'the bump', choices: ['patch', 'minor', 'major'] } } as const

  test('accepts a value in the set, or none', () => {
    const chosen: 'patch' | 'minor' | 'major' | undefined = parse(['--bump', 'minor'], 'u', bump).values.bump
    const several: ('patch' | 'minor' | 'major')[] | undefined = parse([], 'u', { bump: { ...bump.bump, multiple: true } }).values.bump

    // @ts-expect-error the union holds more than 'patch'
    const only: 'patch' | undefined = parse([], 'u', bump).values.bump

    expect(only).toBeUndefined()
    expect(chosen).toBe('minor')
    expect(several).toBeUndefined()
    expect(parse([], 'u', bump).values.bump).toBeUndefined()
  })

  test('refuses another, naming the allowed ones', () => {
    expect(() => parse(['--bump', 'big'], 'u', bump)).toThrow('--bump takes one of patch, minor, major, not big')
    expect(() => parse(['--bump', 'patch', '--bump', 'big'], 'u', { bump: { ...bump.bump, multiple: true } })).toThrow(UsageError)
  })

  test('shows them as the option\'s value in the help', () => {
    expect(optionRows(bump, paint({ isTTY: false }))).toEqual(['      --bump <patch|minor|major>  the bump'])
  })

  test('lists a long set of choices after the description, the flag column staying narrow', () => {
    const only = { only: { type: 'string', description: 'one check', choices: ['bun-version', 'tea-login', 'claude-hooks', 'registry'] }, json: { type: 'boolean', description: 'json' } } as const

    expect(optionRows(only, paint({ isTTY: false }))).toEqual(['      --only <value>  one check; one of bun-version, tea-login, claude-hooks, registry', '      --json          json'])
  })

  test('checks a positional against a set the same way', () => {
    expect(oneOf('minor', '<bump>', ['patch', 'minor'])).toBe('minor')
    expect(() => oneOf('big', '<bump>', ['patch', 'minor'])).toThrow('<bump> takes one of patch, minor, not big')
  })
})

describe('optional values', () => {
  const depth = { out: { type: 'string', short: 'o', description: 'depth', optional: { bare: '1', accepts: /^\d+$/ } }, all: { type: 'boolean' } } as const

  test('reads the fallback bare, and keeps a next word that is no value as a positional', () => {
    expect(parse(['--out'], 'u', depth)).toMatchObject({ values: { out: '1' }, positionals: [] })
    expect(parse(['--out', 'proj'], 'u', depth)).toMatchObject({ values: { out: '1' }, positionals: ['proj'] })
    expect(parse(['-o', '--all'], 'u', depth)).toMatchObject({ values: { out: '1', all: true } })
    expect(parse(['proj', '--out'], 'u', depth)).toMatchObject({ values: { out: '1' }, positionals: ['proj'] })
  })

  test('takes a value that follows it, or is joined to it', () => {
    expect(parse(['--out', '3', 'proj'], 'u', depth)).toMatchObject({ values: { out: '3' }, positionals: ['proj'] })
    expect(parse(['--out=2'], 'u', depth).values.out).toBe('2')
  })

  test('leaves what follows a `--` alone, and without `accepts` takes any word not starting with a dash', () => {
    expect(parse(['--out', '--', 'x'], 'u', depth)).toMatchObject({ values: { out: '1' }, positionals: ['x'] })
    expect(parse(['--out', 'proj'], 'u', { out: { type: 'string', optional: { bare: '1' } } }).values.out).toBe('proj')
  })

  test('shows the value in brackets in the help', () => {
    expect(optionRows(depth, paint({ isTTY: false }))[0]).toBe('  -o, --out [<value>]  depth')
  })
})

describe('conflicts', () => {
  const formats = { md: { type: 'boolean', conflicts: ['pdf'] }, pdf: { type: 'boolean' } } as const

  test('refuses two options given together, naming both', () => {
    expect(() => parse(['--md', '--pdf'], 'u', formats)).toThrow('--md cannot be used with --pdf')
    expect(parse(['--md'], 'u', formats).values.md).toBe(true)
    expect(parse(['--pdf'], 'u', formats).values.pdf).toBe(true)
  })

  test('does not count a negated flag as given', () => {
    expect(parse(['--no-md', '--pdf'], 'u', formats, { allowNegative: true }).values).toEqual({ md: false, pdf: true })
  })
})

describe('negative', () => {
  const refresh = { refresh: { type: 'boolean', negative: 'keep the cached copy' }, md: { type: 'boolean', description: 'markdown', negative: 'no markdown' } } as const

  test('lists --no-<flag> with its description in place of a positive flag that has none', async () => {
    const help = async (settings: { allowNegative?: boolean }) => (await capture(async () => {
      expect(() => parse(['--help'], 'u', refresh, settings)).toThrow(HelpShown)

      return 0
    })).out

    expect(await help({ allowNegative: true })).toContain('      --no-refresh     keep the cached copy\n      --md             markdown\n      --no-md          no markdown\n')
    expect(await help({})).toContain('--refresh')
    expect(await help({})).not.toContain('--no-refresh')
  })

  test('parses the negation only with allowNegative', () => {
    expect(parse(['--no-refresh'], 'u', refresh, { allowNegative: true }).values.refresh).toBe(false)
    expect(() => parse(['--no-refresh'], 'u', refresh)).toThrow(UsageError)
  })
})

describe('trailing', () => {
  const compose = { project: { type: 'string', short: 'p' }, all: { type: 'boolean' } } as const
  const settings = { positionals: ['<project>'], trailing: true } as const

  test('hands everything after the last positional back as rest, dashes included', () => {
    expect(parse(['x', 'exec', '-T', 'php', '--help'], 'u', compose, settings)).toMatchObject({ positionals: ['x'], rest: ['exec', '-T', 'php', '--help'] })
    expect(parse(['x', 'logs', '--tail=200'], 'u', compose, settings)).toMatchObject({ rest: ['logs', '--tail=200'] })
  })

  test('parses the options typed before it, a string one taking its value', () => {
    expect(parse(['--all', '-p', 'p1', 'x', 'up', '--all'], 'u', compose, settings)).toMatchObject({ values: { all: true, project: 'p1' }, positionals: ['x'], rest: ['up', '--all'] })
  })

  test('has no rest until a positional is given, and an empty one when nothing follows', async () => {
    expect(() => parse([], 'u', compose, settings)).toThrow('missing <project>')
    expect(parse(['x'], 'u', compose, settings).rest).toEqual([])
    await capture(async () => {
      expect(() => parse(['--help'], 'u', compose, settings)).toThrow(HelpShown)

      return 0
    })
  })
})

describe('wholeNumber', () => {
  test('reads digits only', () => {
    expect(wholeNumber('12', 'limit', 1)).toBe(12)
    expect(wholeNumber('007', 'limit', 1)).toBe(7)
    expect(wholeNumber(undefined, 'limit', 5)).toBe(5)
  })

  test.each(['1e3', '0x10', '', ' 3', '1.0', '-1', '9'.repeat(20)])('refuses %p', (value) => {
    expect(() => wholeNumber(value, 'limit', 0, 0)).toThrow(UsageError)
  })

  test('names an option with dashes and a positional as written', () => {
    expect(() => wholeNumber('x', 'limit', 1)).toThrow('--limit takes a whole number from 1, not x')
    expect(() => wholeNumber('x', '<run id>', 1)).toThrow('<run id> takes a whole number from 1, not x')
  })
})

describe('jsonOption', () => {
  test('words the flag alike, naming what it holds when given', () => {
    expect(jsonOption()).toEqual({ type: 'boolean', description: 'print JSON' })
    expect(jsonOption('{ findings }')).toEqual({ type: 'boolean', description: 'print JSON: { findings }' })
    expect(parse(['--json'], 'u', { json: jsonOption() }).values.json).toBe(true)
  })
})

describe('aliases', () => {
  const OPTIONS = { rows: { type: 'string', short: 'n', aliases: ['limit'], description: 'rows shown' }, json: jsonOption() } as const

  test('an old spelling reads as the option, bare or with =', () => {
    expect(parse(['--limit', '5'], 'x', OPTIONS).values.rows).toBe('5')
    expect(parse(['--limit=7'], 'x', OPTIONS).values.rows).toBe('7')
    expect(parse(['--rows', '9'], 'x', OPTIONS).values.rows).toBe('9')
  })

  test('is left alone after --, and listed neither in the help nor in the options', async () => {
    expect(parse(['--rows', '1', '--', '--limit'], 'x', OPTIONS, { rest: true }).rest).toEqual(['--limit'])

    const help = (await capture(async () => {
      expect(() => parse(['--help'], 'x', OPTIONS)).toThrow(HelpShown)
    })).out

    expect(help).toContain('--rows')
    expect(help).not.toContain('--limit')
  })
})

describe('exits', () => {
  const OPTIONS = { json: jsonOption() } as const
  const exits: [number, string][] = [[0, 'clean'], [1, 'a finding'], [12, 'a usage error']]

  test('the help lists the codes on one Exit codes: line', async () => {
    const { out } = await capture(async () => {
      expect(() => parse(['--help'], 'x', OPTIONS, { exits })).toThrow(HelpShown)
    })

    expect(out).toContain('Exit codes: 0 clean, 1 a finding, 12 a usage error')
    expect(out.indexOf('Options:')).toBeLessThan(out.indexOf('Exit codes:'))
  })

  test('the description lists the options', () => {
    const listed = description('x: does x', {}, { json: jsonOption(), times: { type: 'string', short: 'n', description: 'how many' } }).options

    expect(listed).toContainEqual({ name: 'times', short: 'n', description: 'how many' })
    expect(listed?.some(({ name }) => name === 'json')).toBe(true)
    expect(description('x: does x').options).toBeUndefined()
  })

  test('the description spells them out', () => {
    expect(description('x: does x', { exits }).exits).toEqual([{ code: 0, meaning: 'clean' }, { code: 1, meaning: 'a finding' }, { code: 12, meaning: 'a usage error' }])
  })
})
