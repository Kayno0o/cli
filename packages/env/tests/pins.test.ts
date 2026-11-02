import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { overriddenNames, reachesOutside } from '../src/pins'

const CLI = new URL('../src/ev.ts', import.meta.url).pathname

const SCHEMA = `import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({
  PORT: s.Integer({ default: 55620 }),
  HOST: s.Optional(s.String()),
  PUBLIC_URL: s.Optional(s.String()),
  LOG_FILE: s.Optional(s.String()),
  FORGEJO_TOKEN: s.Optional(s.String()),
  HUBBLE_URL: s.Optional(s.String()),
  HUBBLE_KEY_FILE: s.Optional(s.String()),
  PROBE_APPS: s.Boolean({ default: true }),
}))
`

const SECRET = 'tok_super_secret_value_1234'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ev-pins-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(path: string, text: string) {
  const full = join(dir, path)

  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, text)
}

function pins(args: string[] = []) {
  const result = Bun.spawnSync([process.execPath, CLI, 'pins', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

const PINNING_TEST = `import { overrideEnv, testSite } from 'kay/test'
import { env } from '../src/env'

overrideEnv(env, { HUBBLE_URL: undefined, HUBBLE_KEY_FILE: undefined, FORGEJO_TOKEN: undefined, PROBE_APPS: false })

const site = await testSite()
`

describe('ev pins', () => {
  test('passes when a test file pins every optional variable reaching outside', async () => {
    await write('src/env.ts', SCHEMA)
    await write('tests/proxy-key.test.ts', PINNING_TEST)

    const { code, out } = pins()

    expect(code).toBe(0)
    expect(out).toContain('3 reaching variables pinned')
  })

  test('names the variables a rendering test leaves unpinned once a pin is removed', async () => {
    await write('src/env.ts', SCHEMA)
    await write('tests/proxy-key.test.ts', PINNING_TEST.replace(' HUBBLE_KEY_FILE: undefined, FORGEJO_TOKEN: undefined,', ''))

    const { code, out } = pins()

    expect(code).toBe(1)
    expect(out).toContain('tests/proxy-key.test.ts renders a page without pinning: FORGEJO_TOKEN, HUBBLE_KEY_FILE')
    expect(out).toContain('unpinned by .env.test or any overrideEnv: FORGEJO_TOKEN, HUBBLE_KEY_FILE')
    expect(out).not.toContain('HUBBLE_URL,')
  })

  test('counts an .env.test entry, even an empty one, as a pin and never prints a value', async () => {
    await write('src/env.ts', SCHEMA)
    await write('.env.test', `FORGEJO_TOKEN=${SECRET}\nHUBBLE_URL=\nHUBBLE_KEY_FILE=/run/secrets/${SECRET}\n`)
    await write('tests/page.test.ts', 'const site = await testSite()\n')

    const { code, out, err } = pins(['--json'])

    expect(code).toBe(0)
    expect(out + err).not.toContain(SECRET)
    expect((JSON.parse(out) as { unpinned: string[] }[])[0]?.unpinned).toEqual([])
  })

  test('flags a variable no test and no env file pins even when no test renders a page', async () => {
    await write('src/env.ts', SCHEMA)
    await write('.env.test', 'FORGEJO_TOKEN=\n')
    await write('tests/unit.test.ts', 'overrideEnv(env, { HUBBLE_URL: undefined })\n')

    const { code, out } = pins()

    expect(code).toBe(1)
    expect(out).toContain('unpinned by .env.test or any overrideEnv: HUBBLE_KEY_FILE')
    expect(out).not.toContain('renders a page')
  })

  test('leaves a test file that renders nothing, a self link and a bind address alone', async () => {
    await write('src/env.ts', SCHEMA)
    await write('.env.test', 'FORGEJO_TOKEN=\nHUBBLE_URL=\nHUBBLE_KEY_FILE=\n')
    await write('tests/unit.test.ts', 'it("adds", () => {})\n')

    expect(pins().code).toBe(0)
    expect(reachesOutside('PUBLIC_URL')).toBe(false)
    expect(reachesOutside('HOST')).toBe(false)
    expect(reachesOutside('LOG_FILE')).toBe(false)
    expect(reachesOutside('DOCKER_HOST')).toBe(true)
    expect(reachesOutside('HUBBLE_KEY_FILE')).toBe(true)
  })

  test('takes a local preload dropping what .env sets as pinning every variable', async () => {
    await write('src/env.ts', SCHEMA)
    await write('bunfig.toml', '[test]\npreload = [ "./tests/no-dotenv.ts", "kay/test/preload" ]\n')
    await write('tests/no-dotenv.ts', 'for (const key of keys(".env")) delete process.env[key]\n')
    await write('tests/page.test.ts', 'const site = await testSite()\n')

    const { code, out } = pins()

    expect(code).toBe(0)
    expect(out).toContain('every variable pinned by ./tests/no-dotenv.ts')
  })

  test('accepts a marker on a file whose pages reach none of the variables', async () => {
    await write('src/env.ts', SCHEMA)
    await write('.env.test', 'FORGEJO_TOKEN=\n')
    await write('tests/a.test.ts', 'const site = await testSite()\n')
    await write('tests/b.test.ts', '// ev pins: none reached, only static pages\nconst site = await testSite()\n')

    const { code, out } = pins()

    expect(code).toBe(1)
    expect(out).toContain('tests/a.test.ts renders a page without pinning: HUBBLE_URL, HUBBLE_KEY_FILE')
    expect(out).not.toContain('tests/b.test.ts')
  })

  test('walks the apps of a monorepo and honours --except', async () => {
    await write('one/src/env.ts', SCHEMA)
    await write('one/tests/page.test.ts', 'const site = await testSite()\n')
    await write('two/src/env.ts', SCHEMA)
    await write('two/.env.test', 'FORGEJO_TOKEN=\nHUBBLE_URL=\nHUBBLE_KEY_FILE=\n')

    const all = pins()

    expect(all.code).toBe(1)
    expect(all.out).toContain('one: 3 optional variables reach outside')
    expect(all.out).toContain('ok: two')

    expect(pins(['--except', 'FORGEJO_TOKEN,HUBBLE_URL,HUBBLE_KEY_FILE']).code).toBe(0)
  })

  test('is a usage error where no env schema exists', () => {
    const { code, err } = pins()

    expect(code).toBe(2)
    expect(err).toContain('no env schema')
  })

  test('reads the override keys of the object only, not those of the values', () => {
    const source = 'overrideEnv(env, { STACKS_DIR: mkdtempSync(join(tmpdir(), \'x-\')), HUBBLE_URL: undefined, NESTED: { INNER: 1 } })\noverrideEnv(other, { A_TOKEN: \'B_KEY: 1\' })'

    expect([...overriddenNames(source)]).toEqual(['STACKS_DIR', 'HUBBLE_URL', 'NESTED', 'A_TOKEN'])
  })
})
