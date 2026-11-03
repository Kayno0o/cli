import type { Command, Entry } from '../src/sf'
import { describe, expect, test } from 'bun:test'
import { answered, argumentsOf, commandFor, key, marked, phpService, signature } from '../src/sf'

function command(name: string, args: Record<string, { is_required: boolean, is_array?: boolean }> | [] = []): Command {
  return {
    name,
    description: '',
    help: '',
    usage: [],
    hidden: false,
    definition: {
      arguments: Array.isArray(args) ? [] : Object.fromEntries(Object.entries(args).map(([argument, found]) => [argument, { name: argument, is_required: found.is_required, is_array: found.is_array ?? false, description: '' }])),
      options: [],
    },
  }
}

const entry = (found: Command, dir = '.'): Entry => ({ app: { dir, run: dir === '.' ? ['php', 'bin/console'] : ['env', '-C', dir, 'php', 'bin/console'], list: { argv: [], cwd: dir, env: {} } }, command: found })

describe('phpService', () => {
  test('prefers php itself, then any service naming php', () => {
    expect(phpService(['db', 'booki-php', 'php'])).toBe('php')
    expect(phpService(['db', 'dorad_php'])).toBe('dorad_php')
    expect(phpService(['db', 'node'])).toBeUndefined()
  })
})

describe('signature', () => {
  test('writes required arguments in angle brackets, optional ones in square brackets, lists with dots', () => {
    expect(signature(command('x', { name: { is_required: true }, extra: { is_required: false }, rest: { is_required: false, is_array: true } }))).toBe('<name> [extra] [rest...]')
  })

  test('reads an empty array as no arguments', () => {
    expect(argumentsOf(command('x', []))).toEqual([])
    expect(signature(command('x', []))).toBe('')
  })
})

describe('key', () => {
  test('is the bare name for this folder and prefixed for a child folder', () => {
    expect(key(entry(command('cache:clear')))).toBe('cache:clear')
    expect(key(entry(command('cache:clear'), 'api'))).toBe('api/cache:clear')
  })
})

describe('commandFor', () => {
  const make = command('make:entity', { name: { is_required: true }, fields: { is_required: true }, force: { is_required: false } })

  test('prompts for each required argument', () => {
    expect(commandFor(entry(make), [])).toEqual(['php', 'bin/console', 'make:entity', { ask: 'name' }, { ask: 'fields' }])
  })

  test('keeps the arguments given and prompts only for the rest', () => {
    expect(commandFor(entry(make), ['User'])).toEqual(['php', 'bin/console', 'make:entity', { given: 'User' }, { ask: 'fields' }])
    expect(commandFor(entry(make), ['User', 'a', '--force'])).toEqual(['php', 'bin/console', 'make:entity', { given: 'User' }, { given: 'a' }, { given: '--force' }])
  })

  test('runs from the child folder with env -C', () => {
    expect(commandFor(entry(command('about'), 'api'), [])).toEqual(['env', '-C', 'api', 'php', 'bin/console', 'about'])
  })
})

describe('answered', () => {
  test('asks for each prompt and remembers given and answered arguments', async () => {
    const asked: string[] = []
    const done = await answered(['php', { given: 'User' }, { ask: 'fields' }], async (name) => {
      asked.push(name)

      return 'a:string'
    })

    expect(asked).toEqual(['fields'])
    expect(done).toEqual({ argv: ['php', 'User', 'a:string'], given: ['User', 'a:string'] })
  })

  test('gives up once a prompt is cancelled', async () => {
    expect(await answered(['php', { ask: 'name' }], async () => undefined)).toBeUndefined()
  })
})

describe('marked', () => {
  test('turns console markup into colors and drops links', () => {
    const text = marked('<info>ok</info> <href=https://x.dev>docs</>')

    expect(text).not.toContain('<info>')
    expect(text).toContain('ok')
    expect(text).not.toContain('<href')
  })
})
