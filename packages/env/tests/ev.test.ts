import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'
import { entries, parseDotenv } from '../src/dotenv'

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

// Runs `ev set TOKEN` under a pseudo-terminal, typing `keys` once it asks, answering the exit code and everything the terminal showed.
async function setOnTerminal(keys: string): Promise<{ code: number, screen: string }> {
  const decoder = new TextDecoder()
  let screen = ''
  const proc = Bun.spawn([process.execPath, CLI, 'set', 'TOKEN'], { cwd: dir, terminal: { cols: 80, rows: 24, data: (_, data) => void (screen += decoder.decode(data, { stream: true })) } })

  try {
    for (let tries = 0; !screen.includes('value of TOKEN'); tries++) {
      if (tries === 100)
        throw new Error(`no prompt: ${screen}`)

      await Bun.sleep(20)
    }

    proc.terminal?.write(keys)

    return { code: await proc.exited, screen }
  }
  finally {
    proc.kill()
    proc.terminal?.close()
  }
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

  test('list, get and grep mask webhook and push URLs under any key, and keep a plain URL', async () => {
    const hook = 'https://discord.com/api/webhooks/123456789012345678/Ab3dEf6hIj9kLm2NoPq5RsT8uVw1Ab3dEf6hIj9kLm2NoPq5RsT8uVw1'
    const push = 'http://127.0.0.1:55601/api/push/Zx9Cv8Bn7Mq6We5Rt4Yu3Io2Pa1S'

    await write('.env', `DISCORD_WEBHOOK_URL=${hook}\nexport HEALTHCHECK_URL_BACKUP=${push}\nSTATUS_ENDPOINT=https://example.com/api/v1/users?page=1&apikey=abcdefghij\nSITE_URL=https://example.com/health\n`)

    for (const args of [['list'], ['get', 'DISCORD_WEBHOOK_URL'], ['get', 'HEALTHCHECK_URL_BACKUP'], ['grep', '_URL|_ENDPOINT']]) {
      const { out } = ev(args)

      expect(out).not.toContain('Ab3dEf6hIj9kLm2NoPq5')
      expect(out).not.toContain('Zx9Cv8Bn7Mq6')
      expect(out).not.toContain('apikey=abcdefghij')
    }

    const { out } = ev(['list'])

    expect(out).toContain('https://discord.com/api/webhooks/123456789012345678/Ab3***(')
    expect(out).toContain('http://127.0.0.1:55601/api/push/Zx9***(28)')
    expect(out).toContain('apikey=ab***(10)')
    expect(out).toContain('https://example.com/health')
  })

  test('list of one file, and a missing file', async () => {
    await write('.env', ENV)
    await write('.env.local', 'ONLY_HERE=1\n')

    expect(ev(['list', '.env.local']).out).not.toContain('PORT')
    expect(ev(['list', 'nope']).code).toBe(2)
  })

  test('a file that is not dotenv is refused by name, never read as empty', async () => {
    await write('app.json', '{"password": "hunter2hunter2"}\n')
    await write('app.conf', 'password: hunter2hunter2\n# a comment\n')
    await write('.envrc', 'use flake\n')
    await write('.env', 'PORT=3000\n')

    for (const args of [['list', 'app.json'], ['get', 'password', 'app.json'], ['grep', 'pass', 'app.json'], ['unset', 'password', 'app.json'], ['diff', '.env', 'app.json']]) {
      const run = ev(args)

      expect(run.code).toBe(2)
      expect(run.err).toContain('app.json is JSON, and ev reads dotenv files (KEY=value lines)')
      expect(run.err).toContain('ev redact < app.json')
    }

    expect(ev(['set', 'TOKEN', 'new.yaml'], 'x').err).toContain('new.yaml is YAML')
    expect(ev(['list', 'app.conf']).err).toContain('app.conf holds no KEY=value line, so it is not a dotenv file')
    expect(await readFile(join(dir, 'app.json'), 'utf8')).toBe('{"password": "hunter2hunter2"}\n')
    // The folder's own .env* files are read as they are, a direnv .envrc with no assignment included
    expect(ev(['list']).code).toBe(0)
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

  test('set, list and get mask a password whose name runs the words together', async () => {
    await write('.env', ENV)

    for (const key of ['PGPASS', 'GPG_PASSPHRASE', 'AUTHORIZATION']) {
      expect(ev(['set', key], 'fakevalue123456\n').out).not.toContain('fakevalue123456')
      expect(ev(['get', key]).out).not.toContain('fakevalue123456')
    }

    expect(ev(['list']).out).not.toContain('fakevalue123456')
  })

  test('set appends a new key, creates the file, and takes -F', async () => {
    await write('value.txt', 'two words\n')

    expect(ev(['set', 'A', '.env.new', '-F', 'value.txt']).code).toBe(0)
    expect(await read('.env.new')).toBe('A="two words"\n')
    expect(ev(['set', 'B', '.env.new'], 'b').code).toBe(0)
    expect(await read('.env.new')).toBe('A="two words"\nB=b\n')
  })

  test('set on a terminal asks for the value and never shows it', async () => {
    const { code, screen } = await setOnTerminal('typed_secret_42\r')

    expect(code).toBe(0)
    expect(await read('.env')).toBe('TOKEN=typed_secret_42\n')
    expect(screen).not.toContain('typed_secret_42')
  })

  test('set on a terminal exits 130 and writes nothing when the prompt is cancelled', async () => {
    expect((await setOnTerminal('\x1B')).code).toBe(130)
    expect(await Bun.file(join(dir, '.env')).exists()).toBe(false)
  })

  test('--quiet prints nothing when set, unset, cp and mv succeed', async () => {
    await write('.env', 'A=1\nB=2\n')

    expect(ev(['set', 'C', '.env', '--quiet'], 'c')).toMatchObject({ code: 0, out: '' })
    expect(ev(['cp', 'A', '--from', '.env', '--to', '.env.copy', '-q'])).toMatchObject({ code: 0, out: '' })
    expect(ev(['mv', 'B', '--from', '.env', '--to', '.env.copy', '-q'])).toMatchObject({ code: 0, out: '' })
    expect(ev(['unset', 'C', '.env', '-q'])).toMatchObject({ code: 0, out: '' })
    expect(await read('.env')).toBe('A=1\n')
    expect(await read('.env.copy')).toBe('A=1\nB=2\n')
  })

  test('set refuses an empty value unless --empty says so', async () => {
    expect(ev(['set', 'A'], '').err).toContain('--empty')
    expect(ev(['set', 'A'], '\n').err).toContain('--empty')
    expect(ev(['set', 'A'], '\r\n').err).toContain('--empty')
    expect(ev(['set', 'A', '--empty']).code).toBe(0)
    expect(await read('.env')).toBe('A=\n')
    expect(ev(['set', 'A', '--empty', '-F', 'x']).code).toBe(2)
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

  test('cp copies a value without printing it: replaced in place, appended, or renamed with --as', async () => {
    const secret = 'fake_Zx9Cv8Bn7Mq6We5Rt4Yu3'

    await write('.env.a', `FORGEJO_TOKEN=${secret}\nOTHER=1\n`)
    await write('.env.b', 'export FORGEJO_TOKEN=old_value_1234\nKEEP=1\n')

    const replaced = ev(['cp', 'FORGEJO_TOKEN', '--from', '.env.a', '--to', '.env.b'])

    expect(replaced.code).toBe(0)
    expect(await read('.env.b')).toBe(`export FORGEJO_TOKEN=${secret}\nKEEP=1\n`)
    expect(await read('.env.a')).toBe(`FORGEJO_TOKEN=${secret}\nOTHER=1\n`)
    expect(replaced.out).toBe('.env.b: FORGEJO_TOKEN=fak***(26)\n')

    const appended = ev(['cp', 'FORGEJO_TOKEN', '--from', '.env.a', '--to', '.env.c', '--as', 'SHARED_TOKEN'])

    expect(appended.code).toBe(0)
    expect(await read('.env.c')).toBe(`SHARED_TOKEN=${secret}\n`)

    const list = ev(['list'])

    expect(list.out).toContain('fak***(26)')
    for (const result of [replaced, appended, list, ev(['cp', 'NOPE', '--from', '.env.a', '--to', '.env.c'])]) {
      expect(result.out + result.err).not.toContain(secret)
      expect(result.out + result.err).not.toMatch(/Zx9Cv8/)
    }
  })

  test('set and cp refuse a value no quoting keeps for both Bun and compose, and write nothing', async () => {
    await write('.env.a', 'RAW="a\\\\$b"\n')

    const set = ev(['set', 'AWKWARD', '.env.a'], 'a"b\'c\\d $HOME\n')

    expect(set).toMatchObject({ code: 1 })
    expect(set.err).toContain('its value holds $, ", \', \\, which no quoting')
    expect(ev(['cp', 'RAW', '--from', '.env.a', '--to', '.env.a', '--as', 'COPY']).code).toBe(1)
    expect(await read('.env.a')).toBe('RAW="a\\\\$b"\n')
  })

  test('set and cp keep an awkward value byte for byte, drop one trailing newline of stdin and leave other lines alone', async () => {
    const value = 'a"b\\c #not-a-comment\nsecond line\\n end'
    const before = '# keep me\n\nA=1   # trailing\nexport B="two words"\n'

    await write('.env.a', before)
    expect(ev(['set', 'AWKWARD', '.env.a'], `${value}\n`).code).toBe(0)
    expect(entries(parseDotenv(await read('.env.a'))).get('AWKWARD')).toBe(value)
    expect(await read('.env.a')).toStartWith(before)

    await write('.env.b', '# other\nC=3\n')
    expect(ev(['cp', 'AWKWARD', '--from', '.env.a', '--to', '.env.b']).code).toBe(0)
    expect(entries(parseDotenv(await read('.env.b'))).get('AWKWARD')).toBe(value)
    expect((await read('.env.b')).startsWith('# other\nC=3\n')).toBe(true)
  })

  test('writes keep the file mode, create a file as 0600 and leave no temp file behind', async () => {
    await write('.env.a', 'A=1\n')
    await chmod(join(dir, '.env.a'), 0o640)

    expect(ev(['set', 'B', '.env.a'], '2').code).toBe(0)
    expect((await stat(join(dir, '.env.a'))).mode & 0o777).toBe(0o640)

    expect(ev(['cp', 'A', '--from', '.env.a', '--to', '.env.new']).code).toBe(0)
    expect((await stat(join(dir, '.env.new'))).mode & 0o777).toBe(0o600)
    expect(ev(['unset', 'B', '.env.a']).code).toBe(0)
    expect((await readdir(dir)).sort()).toEqual(['.env.a', '.env.new'])
  })

  test.skipIf(process.getuid?.() === 0)('a failed write leaves the original file as it was', async () => {
    await write('.env.a', 'A=1\n')
    await chmod(dir, 0o500)

    try {
      expect(ev(['set', 'B', '.env.a'], '2').code).not.toBe(0)
      expect(await read('.env.a')).toBe('A=1\n')
    }
    finally {
      await chmod(dir, 0o700)
    }
  })

  test('cp refuses a key the source lacks and changes nothing', async () => {
    await write('.env.a', 'A=1\n')
    await write('.env.b', 'B=2\n')

    const { code, err } = ev(['cp', 'MISSING', '--from', '.env.a', '--to', '.env.b'])

    expect(code).toBe(1)
    expect(err).toContain('MISSING is not set in .env.a')
    expect(await read('.env.b')).toBe('B=2\n')
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

  test('--json lists keys with masked values and a secret flag', async () => {
    await write('.env', ENV)
    await write('.env.local', 'PORT=4000\n')

    const listed = JSON.parse(ev(['list', '--json']).out) as { file: string, key: string, value: string, secret: boolean }[]

    expect(listed).toContainEqual({ file: '.env', key: 'API_TOKEN', value: 'tok***(20)', secret: true })
    expect(listed).toContainEqual({ file: '.env', key: 'PORT', value: '3000', secret: false })
    expect(listed).toContainEqual({ file: '.env', key: 'DATABASE_URL', value: 'postgres://app:***@db:5432/app', secret: true })
    expect(JSON.parse(ev(['get', 'PORT', '--json']).out)).toEqual([{ file: '.env', key: 'PORT', value: '3000', secret: false }, { file: '.env.local', key: 'PORT', value: '4000', secret: false }])
    expect(JSON.parse(ev(['grep', '^API_', '--json']).out)).toEqual([{ file: '.env', key: 'API_TOKEN', value: 'tok***(20)', secret: true }])
    expect(JSON.parse(ev(['list', '--json', 'nope']).err)).toMatchObject({ error: expect.any(String) })
  })

  test('--json names the keys only one side sets for diff and missing, exiting 1 as without it', async () => {
    await write('.env', 'A=1\nB=secretb\n')
    await write('.env.example', 'A=\nC=\n')

    const diff = ev(['diff', '.env', '.env.example', '--json'])

    expect(diff.code).toBe(1)
    expect(JSON.parse(diff.out)).toEqual({ a: '.env', b: '.env.example', onlyA: ['B'], onlyB: ['C'] })
    expect(diff.out).not.toContain('secretb')
    expect(JSON.parse(ev(['missing', '--json']).out)).toEqual({ a: '.env.example', b: '.env', onlyA: ['C'], onlyB: ['B'] })

    await write('.env', 'A=1\nC=3\n')
    const same = ev(['missing', '--json'])

    expect(same.code).toBe(0)
    expect(JSON.parse(same.out)).toMatchObject({ onlyA: [] })
  })

  test('grep matches keys only and masks their values', async () => {
    await write('.env', ENV)
    await write('.env.local', 'DB_PASSWORD=supersecret\n')

    const { code, out } = ev(['grep', '^DATABASE_|password', '-i'])

    expect(code).toBe(0)
    expect(out).toContain('postgres://app:***@db:5432/app')
    expect(out).toContain('DB_PASSWORD')
    expect(out).not.toContain('supersecret')
    expect(out).not.toContain('PORT')
    expect(ev(['grep', 'hunter22']).code).toBe(1)
    expect(ev(['grep', '(']).code).toBe(2)
  })

  test('show reads an env file at a git revision, masked', async () => {
    const git = (...args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })

    await write('.env', ENV)
    await write('app.conf', 'password: hunter2hunter2\n')
    git('init', '-q')
    git('add', '-f', '.env', 'app.conf')
    git('commit', '-qm', 'x')
    await write('.env', 'PORT=1\n')

    const { code, out } = ev(['show', 'HEAD:.env'])

    expect(code).toBe(0)
    expect(out).toContain('tok***(20)')
    expect(out).toContain('3000')
    expect(out).not.toContain('hunter22')
    expect(ev(['show', 'HEAD:nope']).code).toBe(1)
    expect(ev(['show', '.env']).code).toBe(2)
    expect(ev(['show', 'HEAD:app.json']).err).toContain('app.json is JSON')
    expect(ev(['show', 'HEAD:app.conf']).err).toContain('HEAD:app.conf holds no KEY=value line')
    expect(ev(['show', 'HEAD:app.conf']).err).toContain('git show HEAD:app.conf | ev redact')
  })
})
