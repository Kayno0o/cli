import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { audit, inlineSecrets } from '../src/audit'

const CLI = new URL('../src/ev.ts', import.meta.url).pathname
const VALUE = 'hunter2-never-printed'

let dir = ''

// Under /tmp, whose parents let any account through, so file modes alone decide what others can read.
beforeEach(async () => {
  dir = await mkdtemp('/tmp/ev-audit-')
  await chmod(dir, 0o755)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(name: string, text: string, mode: number) {
  await mkdir(join(dir, name, '..'), { recursive: true })
  await writeFile(join(dir, name), text)
  await chmod(join(dir, name), mode)
}

function ev(args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('inlineSecrets', () => {
  test('names the secrets written out, in map and list form, and URL passwords', () => {
    const compose = [
      'services:',
      '  db:',
      '    environment:',
      `      POSTGRES_PASSWORD: ${VALUE}`,
      '      - "MQTT_TOKEN=abc123"',
      '      KEY: "k-1"',
      '      DATABASE_URL: postgres://app:pw1@db/app',
      '      POSTGRES_PASSWORD: again',
    ].join('\n')

    expect(inlineSecrets(compose)).toEqual(['POSTGRES_PASSWORD', 'MQTT_TOKEN', 'KEY', 'DATABASE_URL'])
  })

  test('leaves out what comes from the environment, a secrets file, or nothing at all', () => {
    const compose = [
      // eslint-disable-next-line no-template-curly-in-string
      '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}',
      '      - API_KEY=$API_KEY',
      '      DB_PASSWORD_FILE: /run/secrets/db',
      '      ADMIN_PASSWORD: /run/secrets/admin',
      '      APP_SECRET: ""',
      '      TOKEN_TTL: 3600',
      '      MYSQL_RANDOM_ROOT_PASSWORD: "1"',
      '      - SKIP_KEY=yes',
      // eslint-disable-next-line no-template-curly-in-string
      '      DATABASE_URL: postgres://app:${DB_PASSWORD}@db/app',
      '    secrets:',
    ].join('\n')

    expect(inlineSecrets(compose)).toEqual([])
  })
})

describe('audit', () => {
  test('finds .env files others can read or git tracks, and readable composes writing secrets out', async () => {
    await $`git init -q`.cwd(dir).quiet()
    await write('.env', `TOKEN=${VALUE}\n`, 0o644)
    await write('.env.example', 'TOKEN=\n', 0o644)
    await write('api/.env.local', `TOKEN=${VALUE}\n`, 0o600)
    await write('api/.env', `TOKEN=${VALUE}\n`, 0o600)
    await write('compose.yaml', `    environment:\n      APP_SECRET: ${VALUE}\n`, 0o644)
    await write('stack/compose.prod.yaml', `      APP_SECRET: ${VALUE}\n`, 0o600)
    await write('node_modules/x/.env', 'A=1\n', 0o644)
    await $`git add -f api/.env.local`.cwd(dir).quiet()

    expect(await audit([dir])).toEqual([
      { path: join(dir, '.env'), readable: true, tracked: false },
      { path: join(dir, 'api/.env.local'), readable: false, tracked: true },
      { path: join(dir, 'compose.yaml'), readable: true, tracked: false, secrets: ['APP_SECRET'] },
    ])
  })

  test('a folder whose own mode shuts others out hides what it holds', async () => {
    await write('private/.env', 'A=1\n', 0o644)
    await chmod(join(dir, 'private'), 0o700)

    expect(await audit([dir])).toEqual([])
  })
})

describe('ev audit', () => {
  test('names each finding with its fix, never a value, and exits 1', async () => {
    await write('.env', `TOKEN=${VALUE}\n`, 0o644)
    await write('compose.yml', `      DB_PASSWORD: ${VALUE}\n`, 0o644)

    const result = ev(['audit'])

    expect(result.code).toBe(1)
    expect(result.out).toBe('.env\n  readable by any account: chmod o-rwx .env\ncompose.yml\n  writes out DB_PASSWORD: move the values into a .env beside it\n  readable by any account: chmod o-rwx compose.yml\n')
    expect(result.out + result.err).not.toContain(VALUE)
    expect(JSON.parse(ev(['audit', '--json']).out)).toHaveLength(2)
  })

  test('exits 0 when nothing is exposed, 2 on a path that is no folder', async () => {
    await write('.env', `TOKEN=${VALUE}\n`, 0o600)

    expect(ev(['audit'])).toMatchObject({ code: 0, out: 'no exposed .env file nor compose file writing a secret out\n' })
    expect(ev(['audit', 'nope']).code).toBe(2)
  })
})
