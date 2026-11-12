import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()
const SAMPLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

// Runs dev under a pseudo-terminal, typing `typed` and Enter once `prompt` shows, answering the exit code and everything the terminal showed.
async function onTerminal(args: string[], prompt: string, typed: string): Promise<{ code: number, screen: string }> {
  const decoder = new TextDecoder()
  let screen = ''
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env: { ...process.env, NO_COLOR: '1', TZ: 'UTC' }, terminal: { cols: 120, rows: 24, data: (_, data) => void (screen += decoder.decode(data, { stream: true })) } })

  try {
    for (let tries = 0; !screen.includes(prompt); tries++) {
      if (tries === 100)
        throw new Error(`no prompt: ${screen}`)

      await Bun.sleep(20)
    }

    proc.terminal?.write(`${typed}\r`)

    return { code: await proc.exited, screen }
  }
  finally {
    proc.kill()
    proc.terminal?.close()
  }
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

  test('--bcrypt alone hashes a generated password and prints that one on stderr', async () => {
    const { out, err } = dev(['password', '-b'])

    expect(out.trim()).toStartWith('$2y$10$')
    expect(await Bun.password.verify(err.trim(), out.trim().replace('$2y$', '$2b$'))).toBe(true)
  })

  test('--bcrypt - reads the password from stdin, or asks for it masked on a terminal', async () => {
    const piped = dev(['password', '--bcrypt', '-'], 'hunter2\n').out.trim()

    expect(await Bun.password.verify('hunter2', piped.replace('$2y$', '$2b$'))).toBe(true)

    const { code, screen } = await onTerminal(['password', '--bcrypt', '-'], 'the password', 'typed_pw_42')
    const hash = (/\$2y\$10\$\S+/).exec(screen)?.[0] ?? ''

    expect(code).toBe(0)
    expect(screen).not.toContain('typed_pw_42')
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
    const { code, screen } = await onTerminal(['jwt'], 'the token', SAMPLE)

    expect(code).toBe(0)
    expect(screen).toContain('John Doe')
    expect(screen).not.toContain(SAMPLE.split('.')[2])
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

describe('dev uuid and ulid', () => {
  test('uuid is v4 by default and v7 with --v7, -n counts', () => {
    expect(dev(['uuid']).out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/)
    expect(dev(['uuid', '--v7', '-n', '3']).out.trim().split('\n')).toHaveLength(3)
    expect(dev(['uuid', '--v7']).out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(JSON.parse(dev(['uuid', '-n', '2', '--json']).out)).toHaveLength(2)
    expect(dev(['uuid', '-n', '0']).code).toBe(2)
  })

  test('ulid', () => {
    expect(dev(['ulid']).out).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\n$/)
    expect(dev(['ulid', '-n', '2']).out.trim().split('\n')).toHaveLength(2)
  })
})

describe('dev b64', () => {
  test('encodes an argument or stdin, --url', () => {
    expect(dev(['b64', 'hello']).out).toBe('aGVsbG8=\n')
    expect(dev(['b64', '--url'], 'hello').out).toBe('aGVsbG8\n')
    expect(dev(['b64'], 'hello\n').out).toBe('aGVsbG8K\n')
  })

  test('decodes with -d, padding optional, raw output', () => {
    expect(dev(['b64', '-d', 'aGVsbG8']).out).toBe('hello')
    expect(dev(['b64', '-d'], 'aGVsbG8=\n').out).toBe('hello')
    expect(JSON.parse(dev(['b64', '-d', 'aGVsbG8=', '--json']).out)).toEqual({ input: 'aGVsbG8=', output: 'hello' })
  })

  test('exit 1 on bad base64, 2 with nothing given', () => {
    expect(dev(['b64', '-d', 'a$b']).code).toBe(1)
    expect(dev(['b64']).code).toBe(2)
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
