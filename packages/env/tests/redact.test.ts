import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { knownSecrets } from '../src/mask'
import { check, Redactor } from '../src/redactor'

const CLI = new URL('../src/ev.ts', import.meta.url).pathname
const GITHUB = `ghp_${'Ab1'.repeat(12)}`
const GITLAB = `glpat-${'x9'.repeat(12)}`
const OPENAI = `sk-${'q'.repeat(40)}`
const SLACK = 'xoxb-1234567890-abcdefghijkl'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz'
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nzzzzbodyzzzz\n-----END RSA PRIVATE KEY-----'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'redact-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function redact(args: string[], stdin: string) {
  const result = Bun.spawnSync([process.execPath, CLI, 'redact', ...args], { cwd: dir, stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('Redactor', () => {
  test('masks a webhook URL and a token query parameter, and leaves a plain URL', () => {
    const redactor = new Redactor()
    const input = 'a http://127.0.0.1:55601/api/push/Zx9Cv8Bn7Mq6We5Rt4Yu3Io2Pa1S b https://example.com/x?sig=abcdefghij c https://example.com/health\n'
    const out = redactor.push(input) + redactor.end()

    expect(out).toBe('a http://127.0.0.1:55601/api/push/Zx9***(28) b https://example.com/x?sig=ab***(10) c https://example.com/health\n')
  })

  test.each([['GitHub', GITHUB], ['GitLab', GITLAB], ['sk-', OPENAI], ['Slack', SLACK], ['JWT', JWT]])('masks a %s token', (_name, token) => {
    const redactor = new Redactor()
    const out = redactor.push(`before ${token} after\n`) + redactor.end()

    expect(out).not.toContain(token)
    expect(out).toStartWith('before ')
    expect(out).toEndWith(' after\n')
  })

  test('replaces a private key block by one marker and keeps the lines around it', () => {
    const redactor = new Redactor()
    const out = redactor.push(`start\n${PEM}\nend\n`) + redactor.end()

    expect(out).toBe('start\n-----BEGIN RSA PRIVATE KEY-----\n*** private key redacted ***\n-----END RSA PRIVATE KEY-----\nend\n')
  })

  test('masks a URL password', () => {
    expect(new Redactor().push('connect postgres://app:hunter22@db/app ok\n')).toBe('connect postgres://app:***@db/app ok\n')
  })

  test('masks a secret split across two chunks, and across every split point', () => {
    const line = `token ${GITHUB} done\n`

    for (let cut = 1; cut < line.length; cut++) {
      const redactor = new Redactor()
      const out = redactor.push(line.slice(0, cut)) + redactor.push(line.slice(cut)) + redactor.end()

      expect(out).not.toContain(GITHUB)
      expect(out).toEndWith(' done\n')
    }
  })

  test('holds back a partial line until its newline, then flushes it at the end', () => {
    const redactor = new Redactor()

    expect(redactor.push('one\ntw')).toBe('one\n')
    expect(redactor.push('o')).toBe('')
    expect(redactor.end()).toBe('two')
  })

  test('masks .env values of 4 characters or more as whole words only', () => {
    const known = knownSecrets([['DB_PASSWORD', 'hunter22'], ['PIN_TOKEN', 'ab1'], ['API_KEY', 'swordfish']])
    const redactor = new Redactor(known)
    const out = redactor.push('pw hunter22 pin ab1 word swordfishing a_swordfish\n')

    expect(out).toBe('pw hu***(8) pin ab1 word swordfishing a_swordfish\n')
  })
})

describe('redact', () => {
  test('masks values of the folder\'s .env files, but leaves other keys\' values', async () => {
    await writeFile(join(dir, '.env'), 'DB_PASSWORD=hunter22\nNODE_ENV=production\nSHORT_TOKEN=abc\n')

    const { code, out } = redact([], 'pw hunter22 env production short abc\n')

    expect(code).toBe(0)
    expect(out).toBe('pw hu***(8) env production short abc\n')
    expect(redact(['--no-env'], 'pw hunter22\n').out).toBe('pw hunter22\n')
  })

  test('streams: a line comes out before the input ends', async () => {
    const child = Bun.spawn([process.execPath, CLI, 'redact'], { cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })

    void child.stdin.write(`first ${GITHUB}\n`)
    await child.stdin.flush()

    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    const first = new TextDecoder().decode(value)

    expect(first).toStartWith('first ')
    expect(first).not.toContain(GITHUB)

    await child.stdin.end()
    await child.exited
  })
})

describe('check', () => {
  test('names the line of each secret and prints none of them', () => {
    const findings = check(`fine\nkey ${GITHUB}\nurl http://u:pass1234@h/x\n`)

    expect(findings).toEqual([
      { file: 'stdin', line: 2, kind: 'GitHub token' },
      { file: 'stdin', line: 3, kind: 'URL password' },
    ])
  })

  test('reads a diff by its added lines, with the new file and line number', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,3 +20,4 @@ context',
      ' unchanged',
      `-removed ${GITHUB}`,
      '+added',
      `+const token = '${OPENAI}'`,
      ' unchanged',
      '',
    ].join('\n')

    expect(check(diff)).toEqual([{ file: 'src/a.ts', line: 22, kind: 'API key' }])
  })

  test('finds a private key once, at its first line', () => {
    expect(check(`a\n${PEM}\n`)).toEqual([{ file: 'stdin', line: 2, kind: 'private key' }])
  })

  test('exits 1 and lists file:line, or exits 0 when clean', async () => {
    await writeFile(join(dir, '.env'), 'API_KEY=swordfish\n')

    const found = redact(['--check'], 'x\nuse swordfish here\n')

    expect(found.code).toBe(1)
    expect(found.out).toBe('stdin:2: value of API_KEY\n')
    expect(redact(['--check'], 'all clear\n')).toMatchObject({ code: 0, out: '' })
  })
})
