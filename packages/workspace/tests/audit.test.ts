import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const AUDIT = new URL('../src/audit-cli.ts', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'))

function audit(...args: string[]) {
  const ran = Bun.spawnSync([process.execPath, AUDIT, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('audit', () => {
  test('prints its version and its usage', () => {
    expect(audit('--version').out.trim()).toBe(version)
    expect(audit('--help').out).toContain('audit [options] [root]')
  })

  test('a root that is no folder is a usage error, and a folder with no bun.lock exits 2 saying so', () => {
    expect(audit(join(dir, 'nowhere')).code).toBe(2)

    const empty = audit(dir)

    expect(empty.code).toBe(2)
    expect(empty.err).toContain('no bun.lock')
  })

  test('a repository holding only a composer.lock without packages is audited, asking osv.dev nothing', () => {
    const repo = join(dir, 'php')

    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'composer.lock'), '{"packages":[],"packages-dev":[]}')

    const ran = audit(repo)

    expect(ran.code).toBe(0)
    expect(ran.out).toContain('no advisory in 1 repository')
  })

  test('an unknown level is a usage error', () => {
    expect(audit('--level', 'severe', dir).code).toBe(2)
  })
})

describe('audit with a bun that answers', () => {
  const fake = mkdtempSync(join(tmpdir(), 'audit-fake-'))
  const repo = join(fake, 'repo')
  const advisory = '{"lodash":[{"id":1,"url":"https://x","title":"t","severity":"high","vulnerable_versions":"<4.17.21"}]}'

  afterAll(() => rmSync(fake, { recursive: true, force: true }))

  // A `bun` on the PATH that prints `all` for `audit --json` and `prod` for `audit --json --prod`.
  function withBun(all: string, prod: string, ...args: string[]) {
    mkdirSync(join(fake, 'bin'), { recursive: true })
    writeFileSync(join(fake, 'bin', 'bun'), `#!/bin/sh\ncase "$*" in *--prod*) printf '%s' '${prod}' ;; *) printf '%s' '${all}' ;; esac\n`, { mode: 0o755 })
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'bun.lock'), '')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ dependencies: { lodash: '4' } }))

    const ran = Bun.spawnSync([process.execPath, AUDIT, ...args, repo], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${join(fake, 'bin')}:${process.env.PATH}` } })

    return { code: ran.exitCode, out: ran.stdout.toString() }
  }

  test('lists a package with its scope, directness and fix, and exits 1', () => {
    const ran = withBun(advisory, advisory)

    expect(ran.code).toBe(1)
    expect(ran.out).toMatch(/lodash\s+high\s+1\s+prod\s+direct\s+4\.17\.21/)
  })

  test('--ignore skips an advisory by numeric id, so a repository with only that one exits 0', () => {
    const ran = withBun(advisory, advisory, '--ignore', '1')

    expect(ran.code).toBe(0)
    expect(ran.out).toContain('no advisory')
  })

  test('calls a package only the full audit lists dev, and --prod then finds nothing', () => {
    expect(withBun(advisory, '{}').out).toMatch(/lodash\s+high\s+1\s+dev/)

    const ran = withBun(advisory, '{}', '--prod')

    expect(ran.code).toBe(0)
    expect(ran.out).toContain('no advisory')
  })

  test('reports an audit that failed, the production one too, instead of calling its packages dev', () => {
    const ran = withBun(advisory, 'error: registry down')

    expect(ran.code).toBe(2)
    expect(ran.out).toContain('audit failed')
  })
})
