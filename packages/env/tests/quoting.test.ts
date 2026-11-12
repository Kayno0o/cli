import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { entries, formatAssignment, parseDotenv, unquotable } from '../src/dotenv'

// Values each reader treats specially somewhere: quotes, backslashes, dollars, comments, line breaks and edge whitespace.
const QUOTABLE = ['plain', 'C:\\dir\\', 'p"q', 'a\\"b', 'it\'s', 'it\'s $5', 'a$b', '$HOME', 'two\nlines $y', 'two\nlines', 'a #b', 'a#b', ' lead', 'trail ', 'say "hi" # now', 'back\\slash', '"quoted"', '\'quoted\'', '`tick`', 'x=y', 'a\tb', '"a" #b', 'a\rb']
const REFUSED = ['a $b "c"', 'back\\slash $x', 'it\'s "x"\nnext', 'a\\$b', 'a\rb\\']
const EXPECTED = Object.fromEntries(QUOTABLE.map((value, index) => [`K${index}`, value]))
const WRITTEN = `${QUOTABLE.map((value, index) => formatAssignment(`K${index}`, value)).join('\n')}\n`

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ev-quote-'))
  await writeFile(join(dir, 'values'), WRITTEN)
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

function picked(env: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(EXPECTED).map(key => [key, env[key]]))
}

describe('formatAssignment', () => {
  test('writes a value Bun reads back as it is', () => {
    const run = Bun.spawnSync([process.execPath, '--no-env-file', '--env-file=values', '-e', 'console.log(JSON.stringify(process.env))'], { cwd: dir, env: {} })

    expect(picked(JSON.parse(run.stdout.toString()) as Record<string, string>)).toEqual(EXPECTED)
  })

  test.skipIf(Bun.which('docker') === null)('writes a value compose reads back as it is', async () => {
    await writeFile(join(dir, 'compose.yaml'), 'services:\n  app:\n    image: scratch\n    env_file: values\n')
    const run = Bun.spawnSync(['docker', 'compose', 'config', '--format', 'json'], { cwd: dir, env: { PATH: process.env.PATH ?? '' } })

    const { environment } = (JSON.parse(run.stdout.toString()) as { services: { app: { environment: Record<string, string> } } }).services.app

    // compose config prints a compose file, so each literal `$` comes out written `$$`.
    expect(picked(Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value.replaceAll('$$', '$')])))).toEqual(EXPECTED)
  })

  test('reads its own writes back, and finds no form for a value that clashes with every one', () => {
    expect(Object.fromEntries(entries(parseDotenv(WRITTEN)))).toEqual(EXPECTED)

    for (const value of REFUSED)
      expect(formatAssignment('K', value)).toBeUndefined()

    expect(unquotable('a $b "c" ')).toBe('its value holds $, ", whitespace at an end, which no quoting lets both Bun\'s --env-file and compose\'s env_file read as it is')
  })
})
