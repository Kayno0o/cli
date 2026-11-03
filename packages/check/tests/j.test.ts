import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const J = new URL('../src/j-cli.ts', import.meta.url).pathname
let root = ''
let cache = ''

function j(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, J, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, NO_COLOR: '1', XDG_CACHE_HOME: cache } })

  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'j-cli-'))
  cache = mkdtempSync(join(tmpdir(), 'j-cache-'))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'Makefile'), 'greet: ## Say hi\n\t@echo hi $(WHO)\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { echo: 'echo from-package', greet: 'echo package' } }))
  writeFileSync(join(root, 'bun.lock'), '')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(cache, { recursive: true, force: true })
})

describe('j', () => {
  test('prints its version and its usage', () => {
    expect(j('--version').out.trim()).toBe(version)
    expect(j('--help').out).toContain('j [name] [args...]')
  })

  test('lists what can run without a terminal, and as JSON', () => {
    const listing = j()

    expect(listing.code).toBe(0)
    expect(listing.out).toContain('Say hi')
    expect((JSON.parse(j('--json').out) as { id: string }[]).map(entry => entry.id)).toEqual(['make:greet', 'bun:echo', 'bun:greet'])
  })

  test('runs a name with its arguments, and the last one again', () => {
    expect(j('echo', 'more').out).toBe('from-package more\n')
    expect(j('-').out).toBe('from-package more\n')
  })

  test('refuses a name several runners share without a terminal, and an unknown one', () => {
    expect(j('greet')).toMatchObject({ code: 1 })
    expect(j('greet').err).toContain('make:greet, bun:greet')
    expect(j('bun:greet').out).toBe('package\n')
    expect(j('ech').err).toContain('did you mean echo?')
  })

  test('prints --names, --list and --emit', () => {
    expect(j('--names').out).toBe('greet\tmake, bun\nmake:greet\tSay hi\nbun:greet\tbun\necho\tbun\n')
    expect(JSON.parse(j('--list').out)).toEqual([
      { label: 'make greet', hint: 'Say hi', typed: 'make:greet', preview: ['--show', 'make', '.', 'greet'], editsTyped: true },
      { label: 'bun echo', hint: '', typed: 'echo', preview: ['--show', 'package', '.', 'echo'], editsTyped: true },
      { label: 'bun greet', hint: '', typed: 'bun:greet', preview: ['--show', 'package', '.', 'greet'], editsTyped: true },
    ])
    expect(j('--emit', 'bun:echo', 'x').out).toBe('run\necho\nbun:echo\n=bun\n=run\n=echo\n+x\n')
    expect(j('--emit').code).toBe(1)
  })

  test('shows the body of a target', () => {
    expect(j('--show', 'make', '.', 'greet').out).toContain('$ make greet')
  })
})
