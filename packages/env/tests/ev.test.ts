import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/ev.ts', import.meta.url).pathname

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ev-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ev(args: string[], stdin = '') {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

async function write(name: string, text: string) {
  await writeFile(join(dir, name), text)
}

async function read(name: string) {
  return readFile(join(dir, name), 'utf8')
}

const ENV = `# app
export API_TOKEN=tok_abcdefghijklmnop
DATABASE_URL="postgres://app:hunter22@db:5432/app"
PORT=3000
CERT="-----BEGIN PRIVATE KEY-----
secretbody
-----END PRIVATE KEY-----"
`

describe('ev', () => {
  test('lists its commands and its version', () => {
    expect(ev(['--help']).out).toContain('missing')
    expect(ev(['--version']).out.trim()).toBe(version)
  })

  test('list masks every secret in every .env* file and never prints one', async () => {
    await write('.env', ENV)
    await write('.env.local', 'DB_PASSWORD=supersecret\n')

    const { code, out } = ev(['list'])

    expect(code).toBe(0)
    expect(out).toContain('.env.local')
    expect(out).toContain('postgres://app:***@db:5432/app')
    expect(out).toContain('PORT')
    expect(out).toContain('3000')
    expect(out).toContain('tok***(20)')
    for (const secret of ['hunter22', 'supersecret', 'tok_abcdefghijklmnop', 'secretbody'])
      expect(out).not.toContain(secret)
  })

  test('list of one file, and a missing file', async () => {
    await write('.env', ENV)
    await write('.env.local', 'ONLY_HERE=1\n')

    expect(ev(['list', '.env.local']).out).not.toContain('PORT')
    expect(ev(['list', 'nope']).code).toBe(2)
  })

  test('get prints one masked value, bare for a file and per file otherwise', async () => {
    await write('.env', ENV)
    await write('.env.local', 'PORT=4000\n')

    expect(ev(['get', 'API_TOKEN', '.env']).out.trim()).toBe('tok***(20)')
    expect(ev(['get', 'PORT']).out).toContain('.env.local')
    expect(ev(['get', 'MISSING']).code).toBe(1)
  })

  test('set reads the value from stdin and keeps the rest of the file', async () => {
    await write('.env', ENV)

    const { code, out } = ev(['set', 'API_TOKEN'], 'new_token_value_123\n')

    expect(code).toBe(0)
    expect(out).not.toContain('new_token_value_123')
    expect(await read('.env')).toBe(ENV.replace('tok_abcdefghijklmnop', 'new_token_value_123'))
  })

  test('set appends a new key, creates the file, and takes -F', async () => {
    await write('value.txt', 'two words\n')

    expect(ev(['set', 'A', '.env.new', '-F', 'value.txt']).code).toBe(0)
    expect(await read('.env.new')).toBe('A="two words"\n')
    expect(ev(['set', 'B', '.env.new'], 'b').code).toBe(0)
    expect(await read('.env.new')).toBe('A="two words"\nB=b\n')
  })

  test('set refuses an empty value', async () => {
    expect(ev(['set', 'A'], '').code).toBe(2)
  })

  test('unset removes a key only', async () => {
    await write('.env', ENV)

    expect(ev(['unset', 'PORT']).code).toBe(0)
    expect(await read('.env')).toBe(ENV.replace('PORT=3000\n', ''))
    expect(ev(['unset', 'PORT']).code).toBe(1)
  })

  test('mv moves the line as written, multiline included', async () => {
    await write('.env', ENV)

    const { code } = ev(['mv', 'CERT', '--from', '.env', '--to', '.env.local'])

    expect(code).toBe(0)
    expect(await read('.env.local')).toBe('CERT="-----BEGIN PRIVATE KEY-----\nsecretbody\n-----END PRIVATE KEY-----"\n')
    expect(await read('.env')).not.toContain('CERT')
  })

  test('mv refuses to replace a key of the target without --force', async () => {
    await write('.env', 'A=1\n')
    await write('.env.local', 'A=2\n')

    expect(ev(['mv', 'A', '--from', '.env', '--to', '.env.local']).code).toBe(1)
    expect(await read('.env')).toBe('A=1\n')
    expect(ev(['mv', 'A', '--from', '.env', '--to', '.env.local', '--force']).code).toBe(0)
    expect(await read('.env.local')).toBe('A=1\n')
    expect(await read('.env')).toBe('')
  })

  test('diff and missing name keys without values', async () => {
    await write('.env', 'A=1\nB=secretb\n')
    await write('.env.example', 'A=\nC=\n')

    const diff = ev(['diff', '.env', '.env.example'])

    expect(diff.code).toBe(1)
    expect(diff.out).toBe('only in .env: B\nonly in .env.example: C\n')

    const missing = ev(['missing'])

    expect(missing.code).toBe(1)
    expect(missing.out).toContain('C')
    expect(missing.out).not.toContain('secretb')

    await write('.env', 'A=1\nC=3\n')
    expect(ev(['missing']).code).toBe(0)
    expect(ev(['diff', '.env', '.env.example']).code).toBe(0)
  })
})
