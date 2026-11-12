import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { entries, parseDotenv, serializeDotenv, setLine } from '../src/dotenv'
import { envFiles, loadKnown, withLocks } from '../src/files'
import { knownSecrets, maskLine, maskValue } from '../src/mask'
import { check, Redactor } from '../src/redactor'

const CLI = new URL('../src/ev.ts', import.meta.url).pathname
const GITHUB = `ghp_${'Ab1'.repeat(12)}`

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ev-hard-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ev(args: string[], stdin = '') {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('secret names', () => {
  test('masks the usual spellings of a password, an auth value or a session by key', () => {
    for (const key of ['DB_PASSWD', 'DB_PASS', 'SMTP_PWD', 'AUTH', 'SALT', 'COOKIE', 'CREDENTIALS', 'SESSION_ID', 'apiKey'])
      expect(maskValue(key, 'abcdefghijkl')).toBe('abc***(12)')

    for (const key of ['PORT', 'COMPASS', 'AUTHOR', 'KEYWORDS'])
      expect(maskValue(key, 'abcdefghijkl')).toBe('abcdefghijkl')
  })
})

describe('more token formats', () => {
  const formats = [
    `AKIA${'A1B2'.repeat(4)}`,
    `ASIA${'Z9Y8'.repeat(4)}`,
    `npm_${'aB3'.repeat(12)}`,
    `sk_live_${'a1B2'.repeat(6)}`,
    `rk_test_${'a1B2'.repeat(6)}`,
    `xapp-1-A0123456789-${'1'.repeat(12)}`,
    `AIza${'Sy-'.repeat(11)}ab`,
    `SG.${'a1'.repeat(11)}.${'B2'.repeat(11)}`,
  ]

  test.each(formats)('masks %s', (token) => {
    const line = `value: ${token} end`

    expect(maskLine(line)).not.toContain(token)
    expect(maskLine(line)).toStartWith('value: ')
  })

  test('masks the credential of an Authorization header and keeps the scheme', () => {
    expect(maskLine('curl -H "Authorization: Bearer abcdef123456" x')).toBe('curl -H "Authorization: Bearer abc***(12)" x')
    expect(maskLine('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic dXN***(20)')
    // eslint-disable-next-line no-template-curly-in-string
    expect(maskLine('Authorization: Bearer ${TOKEN}')).toBe('Authorization: Bearer ${TOKEN}')
  })

  test('masks password= and secret= pairs, quoted or not, but not ordinary words', () => {
    expect(maskLine('connect password=hunter22&x=1')).toBe('connect password=hu***(8)&x=1')
    expect(maskLine('{"client_secret": "abcd1234efgh"}')).toBe('{"client_secret": "abc***(12)"}')
    expect(maskLine('DB_PASSWORD=hunter22')).toBe('DB_PASSWORD=hu***(8)')

    for (const text of ['password: string', 'password=true', 'password=$PASS', 'enter your password here', 'secret=<hidden>', 'password_file=/run/secrets/db', 'max_tokens=4096', 'PWD=/home/user'])
      expect(maskLine(text)).toBe(text)
  })
})

describe('private keys', () => {
  test('masks a key escaped on one line, text after it and a body on the BEGIN line', () => {
    const escaped = '{"key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq\\n-----END PRIVATE KEY-----\\n","next":"ok"}'

    expect(maskLine(escaped)).toBe('{"key":"-----BEGIN PRIVATE KEY-----*** private key redacted ***-----END PRIVATE KEY-----\\n","next":"ok"}')
    expect(maskLine('-----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkq')).not.toContain('MIIE')
    expect(maskLine('-----BEGIN PGP PRIVATE KEY BLOCK----- lQdGBF')).not.toContain('lQdGBF')
  })

  test('the Redactor masks a PGP block, a body on the BEGIN line and the text after END', () => {
    const redactor = new Redactor()
    const out = redactor.push('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF\nabcdef\n-----END PGP PRIVATE KEY BLOCK----- then ghp_x\n-----BEGIN PRIVATE KEY----- BODYBODY\nmore\n-----END PRIVATE KEY-----\n')

    expect(out).toBe('-----BEGIN PGP PRIVATE KEY BLOCK-----\n*** private key redacted ***\n-----END PGP PRIVATE KEY BLOCK----- then ghp_x\n-----BEGIN PRIVATE KEY-----*** private key redacted ***\n-----END PRIVATE KEY-----\n')
  })

  test('check finds a one-line escaped key and a PGP block', () => {
    expect(check('k: "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----"').map(finding => finding.kind)).toEqual(['private key'])
    expect(check('-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----').map(finding => finding.kind)).toEqual(['private key'])
  })
})

describe('urls', () => {
  test('masks a password holding @ or /, up to the last @ before the host', () => {
    expect(maskLine('postgres://u:p@ssw0rd@host/db')).toBe('postgres://u:***@host/db')
    expect(maskLine('postgres://u:pa/ss@host/db')).toBe('postgres://u:***@host/db')
  })

  test('keeps a port followed by a scoped path', () => {
    expect(maskLine('npm i http://localhost:3000/@scope/pkg')).toBe('npm i http://localhost:3000/@scope/pkg')
  })
})

describe('known values', () => {
  test('masks the percent-encoded and JSON-escaped forms of a value', () => {
    const known = knownSecrets([['DB_PASSWORD', 'p@ss "w/rd']])

    expect(maskLine('a=p%40ss%20%22w%2Frd', known)).not.toContain('%40')
    expect(maskLine('{"a":"p@ss \\"w/rd"}', known)).not.toContain('ss')
  })

  test('learns the .env files of subfolders and skips node_modules', async () => {
    await mkdir(join(dir, 'api'))
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'api', '.env'), 'DB_PASSWORD=sub-secret-1\n')
    await writeFile(join(dir, 'node_modules', '.env'), 'DB_PASSWORD=ignored-secret\n')

    const known = await loadKnown(dir)

    expect(maskLine('sub-secret-1 ignored-secret', known)).toBe('sub***(12) ignored-secret')
  })
})

describe('linear time', () => {
  test.each([
    ['a long query', `http://a/?${'a'.repeat(200_000)}`],
    ['a long scheme-like run', 'a.'.repeat(100_000)],
    ['many schemes', 'a://u:'.repeat(30_000)],
    ['many dashes', `password=${'a-'.repeat(100_000)}`],
  ])('maskLine finishes on %s', (_name, line) => {
    const start = performance.now()

    maskLine(line)

    expect(performance.now() - start).toBeLessThan(3000)
  })

  test('the Redactor holds a never-ending line in bounded memory and still masks it', () => {
    const redactor = new Redactor()
    const start = performance.now()
    let out = ''

    for (let index = 0; index < 400; index++)
      out += redactor.push('x'.repeat(1000))

    out += redactor.push(` ${GITHUB} `) + redactor.end()

    expect(out).not.toContain(GITHUB)
    expect(out.length).toBeGreaterThan(400_000)
    expect(performance.now() - start).toBeLessThan(5000)
  })

  test('the Redactor reads a 200k line pushed in small chunks in linear time', () => {
    const redactor = new Redactor()
    const start = performance.now()
    const line = `http://a/?${'a'.repeat(200_000)}\n`
    let out = ''

    for (let at = 0; at < line.length; at += 4096)
      out += redactor.push(line.slice(at, at + 4096))

    expect(out + redactor.end()).toContain('http://a/?')
    expect(performance.now() - start).toBeLessThan(5000)
  })
})

describe('dotenv writes', () => {
  test('escapes a dollar sign so Bun does not expand it, and reads it back', () => {
    for (const value of ['pa$word', 'a $b "c" d', 'it\'s $5', 'back\\slash $x', 'two\nlines $y']) {
      const file = parseDotenv('')

      setLine(file, 'PW', value)

      expect(serializeDotenv(file)).not.toMatch(/[^\\]\$/)
      expect(entries(parseDotenv(serializeDotenv(file))).get('PW')).toBe(value)
    }
  })

  test('one file spelled two ways or through a symlink takes its lock once', async () => {
    const path = join(dir, 'f')

    await writeFile(path, 'A=1\n')
    await symlink(path, join(dir, 'link'))

    expect(await withLocks([path, `${dir}/./f`, join(dir, 'link')], async () => 'ran')).toBe('ran')
  })

  test('a lock held by another run makes the write wait for it', async () => {
    const path = join(dir, 'f')
    let inside = 0
    let overlap = false

    await Promise.all([1, 2, 3].map(async () => withLocks([path], async () => {
      inside++
      overlap ||= inside > 1
      await Bun.sleep(20)
      inside--
    })))

    expect(overlap).toBe(false)
  })
})

describe('ev commands', () => {
  test('get masks the value of DB_PASS, and a secret copied to a plain key stays masked', async () => {
    await writeFile(join(dir, 'f'), 'DB_PASS=hunter-two\nAPI_KEY=abcdefgh-ijkl\n')

    expect(ev(['get', 'DB_PASS', 'f']).out).toBe('hu***(10)\n')
    expect(ev(['cp', 'API_KEY', '--from', 'f', '--to', 'f', '--as', 'NOTES']).out).not.toContain('abcdefgh')
    expect(ev(['get', 'NOTES', 'f']).out).toBe('abc***(13)\n')
    expect(ev(['list', 'f']).out).not.toContain('abcdefgh')
  })

  test('set refuses a key holding a line break and writes nothing', async () => {
    const result = ev(['set', 'A=1\nEVIL', 'f'], 'x')

    expect(result.code).toBe(2)
    expect(await Bun.file(join(dir, 'f')).exists()).toBe(false)
    expect(ev(['cp', 'A', '--from', 'f', '--to', 'g', '--as', 'B C']).code).toBe(2)
  })

  test('set stores a dollar sign Bun reads back whole', async () => {
    expect(ev(['set', 'PW', 'f'], 'pa$word\n').code).toBe(0)
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('PW="pa\\$word"\n')
  })

  test('show refuses a revision that reads as a git option', async () => {
    const out = join(dir, 'written')
    const result = ev(['show', `--output=${out}:x`])

    expect(result.code).not.toBe(0)
    expect(await Bun.file(out).exists()).toBe(false)
  })

  test('a symlinked .env.local is listed and its secrets are learned', async () => {
    await mkdir(join(dir, 'real'))
    await writeFile(join(dir, 'real', 'env'), 'DB_PASSWORD=linked-secret\n')
    await symlink(join(dir, 'real', 'env'), join(dir, '.env.local'))
    await symlink(join(dir, 'nowhere'), join(dir, '.env.dangling'))

    expect(await envFiles(dir)).toEqual(['.env.local'])
    expect(ev(['list']).out).toContain('lin***(13)')
  })
})
