import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { audit, inlineSecrets } from '../src/audit'
import { composeEntry, shutOthersOut } from '../src/fix'

const CLI = new URL('../src/ev.ts', import.meta.url).pathname
const VALUE = 'hunter2-never-printed'

let dir = ''

// Under /tmp, whose parents let any account through, so file modes alone decide what others can read.
beforeEach(async () => {
  dir = await mkdtemp('/tmp/ev-audit-')
  await chmod(dir, 0o755)
})

// A test may lock a folder away, which rm could not then enter.
afterEach(async () => {
  await $`chmod -R u+rwx ${dir}`.quiet()
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
    await write('docker-compose-prod.yml', `      APP_SECRET: ${VALUE}\n`, 0o644)
    await write('stack/compose.prod.yaml', `      APP_SECRET: ${VALUE}\n`, 0o600)
    await write('node_modules/x/.env', 'A=1\n', 0o644)
    await $`git add -f api/.env.local`.cwd(dir).quiet()

    expect((await audit([dir])).exposed).toEqual([
      { path: join(dir, '.env'), readable: true, tracked: false },
      { path: join(dir, 'api/.env.local'), readable: false, tracked: true },
      { path: join(dir, 'compose.yaml'), readable: true, tracked: false, secrets: ['APP_SECRET'] },
      { path: join(dir, 'docker-compose-prod.yml'), readable: true, tracked: false, secrets: ['APP_SECRET'] },
    ])
  })

  test('a folder whose own mode shuts others out hides what it holds, and one it cannot list is named', async () => {
    await write('private/.env', 'A=1\n', 0o644)
    await chmod(join(dir, 'private'), 0o700)

    expect(await audit([dir])).toEqual({ exposed: [], unread: [] })

    await mkdir(join(dir, 'locked'))
    await chmod(join(dir, 'locked'), 0o000)

    expect((await audit([dir])).unread).toEqual(process.getuid?.() === 0 ? [] : [join(dir, 'locked')])
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
    expect((JSON.parse(ev(['audit', '--json']).out) as { exposed: unknown[] }).exposed).toHaveLength(2)
  })

  test('exits 0 when nothing is exposed, 2 on a path that is no folder', async () => {
    await write('.env', `TOKEN=${VALUE}\n`, 0o600)

    expect(ev(['audit'])).toMatchObject({ code: 0, out: 'no exposed .env file nor compose file writing a secret out\n' })
    expect(ev(['audit', 'nope']).code).toBe(2)
  })

  test.skipIf(process.getuid?.() === 0)('names up to three folders it cannot read, and only counts more', async () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      await mkdir(join(dir, name))
      await chmod(join(dir, name), 0o000)
    }

    expect(ev(['audit']).err).toBe('could not read 4 folders, so they were not audited (--json lists them)\n')

    await chmod(join(dir, 'd'), 0o755)

    expect(ev(['audit']).err.split('\n').filter(Boolean)).toHaveLength(3)
  })
})

/* eslint-disable no-template-curly-in-string -- compose references are what these tests are about */
describe('composeEntry', () => {
  test('reads a value as compose does and swaps it for a reference keeping the line\'s style', () => {
    const ref = '${KEY}'
    const swapped = (line: string) => {
      const entry = composeEntry(line)

      return entry !== undefined && 'swap' in entry ? [entry.value, entry.swap(ref)] : entry
    }

    expect(swapped('      KEY: plain value  # note')).toEqual(['plain value', `      KEY: ${ref}  # note`])
    expect(swapped('      "KEY": "a \\"b\\" \\\\ c"')).toEqual(['a "b" \\ c', `      "KEY": "${ref}"`])
    expect(swapped('      KEY: \'it\'\'s\'')).toEqual(['it\'s', `      KEY: '${ref}'`])
    expect(swapped('      - KEY=abc$$def')).toEqual(['abc$$def', `      - KEY=${ref}`])
    expect(swapped('      - "KEY=a b" # note')).toEqual(['a b', `      - "KEY=${ref}" # note`])
    expect(composeEntry('      KEY: |')).toMatchObject({ unmovable: expect.any(String) })
    expect(composeEntry('      KEY: "a\\tb"')).toMatchObject({ unmovable: expect.any(String) })
    expect(composeEntry('    image: alpine')).toBeUndefined()
  })
})

describe('shutOthersOut', () => {
  // As root the chmod would go through and change the real file.
  test.skipIf(process.getuid?.() === 0)('answers false on a file another account owns, leaving it as it was', async () => {
    const before = (await stat('/etc/passwd')).mode

    expect(await shutOthersOut('/etc/passwd')).toBe(false)
    expect((await stat('/etc/passwd')).mode).toBe(before)
  })
})

describe('ev audit --fix', () => {
  const docker = Bun.which('docker') !== null
  const checked = docker ? 'docker compose config resolves the same' : 'not checked against docker compose config: docker is not installed'

  test('moves every form of inline secret into a new .env, shuts others out, never prints a value and exits 0', async () => {
    await write('compose.yml', [
      'services:',
      '  app:',
      '    image: alpine',
      '    environment:',
      `      DB_PASSWORD: ${VALUE}`,
      '      "API_TOKEN": "tok en"',
      '      SESSION_SECRET: \'sq-secret\'',
      '      DATABASE_URL: postgres://app:pw1@db/app  # app database',
      '      LOG_LEVEL: info',
      '  worker:',
      '    image: alpine',
      '    environment:',
      '      - "MQTT_TOKEN=abc$$def"',
      `      - DB_PASSWORD=${VALUE}`,
      '',
    ].join('\n'), 0o644)

    const before = docker ? await $`docker compose -f compose.yml config`.cwd(dir).quiet().text() : ''
    const result = ev(['audit', '--fix'])

    expect(result).toEqual({ code: 0, out: `compose.yml\n  moved DB_PASSWORD, API_TOKEN, SESSION_SECRET, DATABASE_URL, MQTT_TOKEN into .env\n  ${checked}\n  now unreadable by other accounts\n`, err: '' })
    expect(await Bun.file(join(dir, 'compose.yml')).text()).toBe([
      'services:',
      '  app:',
      '    image: alpine',
      '    environment:',
      '      DB_PASSWORD: ${DB_PASSWORD}',
      '      "API_TOKEN": "${API_TOKEN}"',
      '      SESSION_SECRET: \'${SESSION_SECRET}\'',
      '      DATABASE_URL: ${DATABASE_URL}  # app database',
      '      LOG_LEVEL: info',
      '  worker:',
      '    image: alpine',
      '    environment:',
      '      - "MQTT_TOKEN=${MQTT_TOKEN}"',
      '      - DB_PASSWORD=${DB_PASSWORD}',
      '',
    ].join('\n'))
    expect(await Bun.file(join(dir, '.env')).text()).toBe(`DB_PASSWORD=${VALUE}\nAPI_TOKEN='tok en'\nSESSION_SECRET=sq-secret\nDATABASE_URL=postgres://app:pw1@db/app\nMQTT_TOKEN='abc$def'\n`)
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'compose.yml'))).mode & 0o777).toBe(0o640)
    expect(ev(['audit']).code).toBe(0)

    if (docker)
      expect(await $`docker compose -f compose.yml config`.cwd(dir).quiet().text()).toBe(before)
  })

  test('leaves a key the .env sets to another value, or one reading another variable, and exits 1', async () => {
    await write('.env', 'KEEP=1\nDB_PASSWORD=other\nAPI_TOKEN=same\n', 0o644)
    await write('compose.yml', [
      'services:',
      '  app:',
      '    image: alpine',
      '    environment:',
      `      DB_PASSWORD: ${VALUE}`,
      '      API_TOKEN: same',
      '      DATABASE_URL: postgres://$${USER}:pw1@db/app',
      '      REDIS_URL: redis://${REDIS_USER}:pw2@redis',
      '',
    ].join('\n'), 0o644)

    const result = ev(['audit', '--fix'])

    expect(result.code).toBe(1)
    expect(result.out).toBe(`.env\n  now unreadable by other accounts\ncompose.yml\n  moved API_TOKEN, DATABASE_URL into .env\n  left DB_PASSWORD in place: .env already sets it to another value\n  left REDIS_URL in place: its value reads another variable\n  ${checked}\n  now unreadable by other accounts\n`)
    expect(result.out).not.toContain(VALUE)
    expect(await Bun.file(join(dir, '.env')).text()).toBe('KEEP=1\nDB_PASSWORD=other\nAPI_TOKEN=same\nDATABASE_URL=\'postgres://${USER}:pw1@db/app\'\n')
    expect(await Bun.file(join(dir, 'compose.yml')).text()).toContain(`DB_PASSWORD: ${VALUE}`)
    expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o640)
  })

  test.skipIf(Bun.which('docker') === null)('puts everything back when docker compose config resolves differently once moved, naming the service env_file would hand it to', async () => {
    const compose = [
      'services:',
      '  app:',
      '    image: alpine',
      '    environment:',
      `      DB_PASSWORD: ${VALUE}`,
      '  other:',
      '    image: alpine',
      '    env_file: .env',
      '',
    ].join('\n')

    await write('.env', 'KEEP=1\n', 0o600)
    await write('compose.yml', compose, 0o644)

    const result = ev(['audit', '--fix'])

    expect(result).toMatchObject({ code: 1, out: 'compose.yml\n  left DB_PASSWORD in place: other loads the .env through env_file and would gain it, so it was put back\n  docker compose config resolved differently, so everything was put back\n  now unreadable by other accounts\n' })
    expect(await Bun.file(join(dir, 'compose.yml')).text()).toBe(compose)
    expect(await Bun.file(join(dir, '.env')).text()).toBe('KEEP=1\n')
  })
})
