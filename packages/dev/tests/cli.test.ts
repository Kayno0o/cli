import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { onTerminal, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()
const SAMPLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

// Runs dev under a pseudo-terminal, typing `typed` and Enter once `prompt` shows, answering the exit code, the screen and everything the command wrote.
async function typedOnTerminal(args: string[], prompt: string, typed: string): Promise<{ code: number, screen: string, raw: string }> {
  return onTerminal([process.execPath, CLI, ...args], async ({ until, type, exited, screen, raw }) => {
    await until(prompt)
    type(`${typed}\r`)
    const code = await exited

    return { code, screen: await screen(), raw: raw() }
  }, { env: { ...process.env, NO_COLOR: '1', TZ: 'UTC' }, cols: 120 })
}

function dev(args: string[], stdin?: string) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1', TZ: 'UTC' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('dev password', () => {
  test('leaves the clipboard alone unless --copy', () => {
    const bin = temp()
    const clip = join(bin, 'clip')

    for (const tool of ['wl-copy', 'xclip', 'xsel', 'pbcopy'])
      writeFileSync(join(bin, tool), `#!/bin/sh\n/bin/cat > ${clip}\n`, { mode: 0o755 })

    const run = (args: string[]) => Bun.spawnSync([process.execPath, CLI, 'password', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: bin, WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', NO_COLOR: '1' } })

    expect(run([]).exitCode).toBe(0)
    expect(Bun.file(clip).size).toBe(0)

    const copied = run(['--copy'])

    expect(copied.stderr.toString()).toContain('copied to clipboard')
    expect(Bun.spawnSync(['cat', clip]).stdout.toString().trim()).toBe(copied.stdout.toString().trim())
  })

  test('defaults to 32 bytes of base64', () => {
    const { code, out } = dev(['password'])

    expect(code).toBe(0)
    expect(out).toMatch(/^[\w+/]{43}=\n$/)
  })

  test('takes a length and a format', () => {
    expect(dev(['password', '8', 'hex']).out).toMatch(/^[0-9a-f]{16}\n$/)
    expect(dev(['password', '32', 'base64url']).out).toMatch(/^[\w-]{43}\n$/)
  })

  test('--bcrypt hashes the given password with $2y$', async () => {
    const { code, out } = dev(['password', '--bcrypt', 'hunter2'])
    const hash = out.trim()

    expect(code).toBe(0)
    expect(hash).toStartWith('$2y$10$')
    expect(await Bun.password.verify('hunter2', hash.replace('$2y$', '$2b$'))).toBe(true)
  })

  test('--bcrypt refuses a password over 72 bytes, given or generated', () => {
    expect(dev(['password', '--bcrypt', 'a'.repeat(72)]).code).toBe(0)
    expect(dev(['password', '--bcrypt', 'a'.repeat(73)])).toMatchObject({ code: 2, err: expect.stringContaining('at most 72 bytes') })
    expect(dev(['password', '64', '--bcrypt'])).toMatchObject({ code: 2, err: expect.stringContaining('pick a smaller <length>') })
  })

  test('--bcrypt alone hashes a generated password and prints that one on stderr', async () => {
    const { out, err } = dev(['password', '-b'])

    expect(out.trim()).toStartWith('$2y$10$')
    expect(await Bun.password.verify(err.trim(), out.trim().replace('$2y$', '$2b$'))).toBe(true)
  })

  test('--bcrypt - reads the password from stdin, or asks for it masked on a terminal', async () => {
    const piped = dev(['password', '--bcrypt', '-'], 'hunter2\n').out.trim()

    expect(await Bun.password.verify('hunter2', piped.replace('$2y$', '$2b$'))).toBe(true)

    const { code, screen, raw } = await typedOnTerminal(['password', '--bcrypt', '-'], 'the password', 'typed_pw_42')
    const hash = (/\$2y\$10\$\S+/).exec(screen)?.[0] ?? ''

    expect(code).toBe(0)
    expect(raw).not.toContain('typed_pw_42')
    expect(await Bun.password.verify('typed_pw_42', hash.replace('$2y$', '$2b$'))).toBe(true)
  })

  test('--json', () => {
    expect(JSON.parse(dev(['password', '4', 'hex', '--json']).out)).toMatchObject({ format: 'hex', bytes: 4, copied: false, password: expect.stringMatching(/^[0-9a-f]{8}$/) })
    expect(JSON.parse(dev(['password', '--bcrypt', 'x', '--json']).out)).toMatchObject({ hash: expect.stringMatching(/^\$2y\$/) })
  })

  test('usage errors exit 2', () => {
    expect(dev(['password', '0']).code).toBe(2)
    expect(dev(['password', 'abc']).code).toBe(2)
    expect(dev(['password', '16', 'octal']).code).toBe(2)
    expect(dev(['password', '99999']).code).toBe(2)
  })
})

describe('dev jwt', () => {
  test('decodes the argument', () => {
    const { code, out } = dev(['jwt', SAMPLE])

    expect(code).toBe(0)
    expect(out).toContain('"name": "John Doe"')
    expect(out).toContain('iat  2018-01-18 01:30:22 +00:00  2018-01-18 01:30:22 UTC')
  })

  test('reads stdin and --json with --zone', () => {
    const json = JSON.parse(dev(['jwt', '--json', '--zone', 'Europe/Paris'], `${SAMPLE}\n`).out) as { header: unknown, claims: unknown[] }

    expect(json.header).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(json.claims[0]).toMatchObject({ claim: 'iat', local: '2018-01-18 02:30:22 +01:00' })
  })

  test('asks for the token masked on a terminal', async () => {
    const { code, screen, raw } = await typedOnTerminal(['jwt'], 'the token', SAMPLE)

    expect(code).toBe(0)
    expect(screen).toContain('John Doe')
    expect(raw).not.toContain(SAMPLE.split('.')[2])
  })

  test('exit 1 on a bad token, 2 with nothing given or a bad zone', () => {
    expect(dev(['jwt', 'nope']).code).toBe(1)
    expect(dev(['jwt']).code).toBe(2)
    expect(dev(['jwt', SAMPLE, '--zone', 'Nowhere/Land']).code).toBe(2)
  })
})

describe('dev ts', () => {
  test('converts an epoch in the given zone', () => {
    expect(dev(['ts', '1700000000', '--zone', 'Europe/Paris']).out).toContain('local     2023-11-14 23:13:20 +01:00\nutc       2023-11-14 22:13:20 UTC\n')
  })

  test('no value is now, and - reads stdin', () => {
    expect(JSON.parse(dev(['ts', '--json']).out)).toMatchObject({ kind: 'now' })
    expect(JSON.parse(dev(['ts', '-', '--json'], '1700000000\n').out)).toMatchObject({ kind: 'epoch-seconds', utc: '2023-11-14 22:13:20 UTC' })
  })

  test('a duration', () => {
    expect(JSON.parse(dev(['ts', '2h30m', '--json']).out)).toMatchObject({ kind: 'duration', seconds: 9000, human: '2h 30m' })
  })

  test('exit 1 on an unreadable value', () => {
    expect(dev(['ts', 'soon']).code).toBe(1)
  })
})

describe('dev id', () => {
  test('mints uuid (default), v7, ulid and hex, -n counts', () => {
    expect(dev(['id']).out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/)
    expect(dev(['id', 'v7', '-n', '3']).out.trim().split('\n')).toHaveLength(3)
    expect(dev(['id', 'v7']).out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(dev(['id', 'ulid']).out).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\n$/)
    expect(dev(['id', 'hex', '--bytes', '8']).out).toMatch(/^[0-9a-f]{16}\n$/)
    expect(JSON.parse(dev(['id', 'uuid', '-n', '2', '--json']).out)).toHaveLength(2)
    expect(dev(['id', '-n', '0']).code).toBe(2)
    expect(dev(['id', 'uuid', '--bytes', '8']).code).toBe(2)
  })
})

describe('dev enc and dec', () => {
  test('encodes and decodes b64, b64url, hex, url and html', () => {
    expect(dev(['enc', 'b64', 'hello']).out).toBe('aGVsbG8=\n')
    expect(dev(['enc', 'b64url'], 'hello').out).toBe('aGVsbG8\n')
    expect(dev(['enc', 'hex', 'hi']).out).toBe('6869\n')
    expect(dev(['enc', 'url', 'a b&c']).out).toBe('a%20b%26c\n')
    expect(dev(['enc', 'html', '<a "x">']).out).toBe('&lt;a &quot;x&quot;&gt;\n')

    expect(dev(['dec', 'b64', 'aGVsbG8']).out).toBe('hello')
    expect(dev(['dec', 'b64url'], 'aGVsbG8=\n').out).toBe('hello')
    expect(dev(['dec', 'hex', '6869']).out).toBe('hi')
    expect(dev(['dec', 'url', 'a%20b%26c']).out).toBe('a b&c')
    expect(dev(['dec', 'html', '&lt;a&gt;&#39;']).out).toBe('<a>\'')
    expect(JSON.parse(dev(['dec', 'b64', 'aGVsbG8=', '--json']).out)).toEqual({ encoding: 'b64', input: 'aGVsbG8=', output: 'hello' })
  })

  test('exit 1 on bad encoded input, 2 on usage errors', () => {
    expect(dev(['dec', 'b64', 'a$b']).code).toBe(1)
    expect(dev(['dec', 'hex', 'zz']).code).toBe(1)
    expect(dev(['dec', 'url', '%E0%A4%A']).code).toBe(1)
    expect(dev(['enc', 'b64']).code).toBe(2)
  })
})

describe('dev cron', () => {
  test('explains a cron schedule and computes upcoming runs', () => {
    const res = dev(['cron', '30 9 * * 1-5', '-n', '3', '--json'])

    expect(res.code).toBe(0)
    const data = JSON.parse(res.out) as { description: string, next: { iso: string }[] }

    expect(data.description).toContain('At 09:30')
    expect(data.next).toHaveLength(3)
    expect((JSON.parse(dev(['cron', '@daily', '--json']).out) as { normalized: string }).normalized).toBe('0 0 * * *')
    expect(dev(['cron', 'not a cron']).code).toBe(1)
  })
})

describe('dev convert', () => {
  test('converts between json, yaml and toml', () => {
    const yaml = dev(['convert', 'json', 'yaml'], '{"name":"app","port":8080}\n')

    expect(yaml.code).toBe(0)
    expect(yaml.out).toContain('name: app')

    const toml = dev(['convert', 'yaml', 'toml'], 'name: app\nserver:\n  port: 8080\n')

    expect(toml.code).toBe(0)
    expect(toml.out).toContain('name = "app"')
    expect(toml.out).toContain('[server]')
    expect(toml.out).toContain('port = 8080')

    const back = dev(['convert', 'toml', 'json', '--compact'], toml.out)

    expect(back.code).toBe(0)
    expect(JSON.parse(back.out)).toEqual({ name: 'app', server: { port: 8080 } })
  })
})

describe('dev url', () => {
  test('prints the parts and the decoded query', () => {
    const { out } = dev(['url', 'https://example.com:8443/a%20b?q=x%26y#top'])

    expect(out).toContain('hostname  example.com')
    expect(out).toContain('pathname  /a b')
    expect(out).toContain('?q        x&y')
  })

  test('reads stdin and --json, exit 1 on a bad URL', () => {
    expect(JSON.parse(dev(['url', '--json'], 'https://example.com/?a=1\n').out)).toMatchObject({ query: [{ key: 'a', value: '1' }] })
    expect(dev(['url', 'nope']).code).toBe(1)
  })
})

describe('dev hash', () => {
  test('stdin and a file give the known digests', () => {
    const dir = temp('dev-')

    writeFileSync(join(dir, 'abc.txt'), 'abc')

    expect(dev(['hash', 'sha256', join(dir, 'abc.txt')]).out).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n')
    expect(dev(['hash', 'sha1'], 'abc').out).toBe('a9993e364706816aba3e25717850c26c9cd0d89d\n')
    expect(JSON.parse(dev(['hash', 'md5', '--json'], 'abc').out)).toMatchObject({ hash: '900150983cd24fb0d6963f7d28e17f72' })
  })

  test('exit 1 on a missing file, 2 on an unknown algorithm or nothing to read', () => {
    expect(dev(['hash', 'sha256', '/nonexistent']).code).toBe(1)
    expect(dev(['hash', 'crc32']).code).toBe(2)
    expect(dev(['hash', 'sha256']).code).toBe(2)
  })
})

describe('dev __complete', () => {
  test('lists the commands and a command\'s values', () => {
    expect(dev(['__complete', '']).out).toContain('password')
    expect(dev(['__complete', 'password', '']).out).toBe('16\n24\n32\n48\n64\n')
    expect(dev(['__complete', 'password', '16', '']).out).toContain('hex\thexadecimal')
    expect(dev(['__complete', 'hash', '']).out).toContain('sha256')
  })
})
