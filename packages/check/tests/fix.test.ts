import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { capture } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { changedFiles, dirtyFiles } from '../src/changes'
import { fix, fixers } from '../src/fix'

let dir: string

process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'fix-runtime-'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fix-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const names = async () => (await fixers(dir)).map(fixer => fixer.name)
const scripts = (values: Record<string, string>) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: values }))

async function failure(run: Promise<number>): Promise<string> {
  try {
    await run
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return ''
}

async function repo(): Promise<void> {
  await $`git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.cwd(dir).quiet()
}

describe('fixers', () => {
  test('none in an empty folder', async () => {
    expect(await names()).toEqual([])
  })

  test('the project\'s fix script alone when it has one, else lint:fix and format', async () => {
    scripts({ 'fix': 'x', 'lint:fix': 'x', 'format': 'x' })
    expect(await names()).toEqual(['fix'])

    scripts({ 'lint-fix': 'x', 'format': 'x', 'lint': 'x' })
    expect(await names()).toEqual(['lint-fix', 'format'])
  })

  test('skips a fix script calling this bin, and takes a Justfile recipe or Makefile target', async () => {
    scripts({ 'fix': 'fix --only lint:fix', 'lint:fix': 'x' })
    expect(await names()).toEqual(['lint:fix'])

    rmSync(join(dir, 'package.json'))
    writeFileSync(join(dir, 'Makefile'), 'fix:\n\ttrue\n')
    expect((await fixers(dir)).map(fixer => fixer.command)).toEqual(['make fix', 'declare every target .PHONY'])
  })

  test('the formatters the folder\'s files call for, ruff only where configured', async () => {
    writeFileSync(join(dir, '.justfile'), 'a:\n')
    writeFileSync(join(dir, 'go.mod'), 'module x\n')
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\n')
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.black]\n')
    expect(await names()).toEqual(['justfile', 'go', 'rust'])

    writeFileSync(join(dir, 'pyproject.toml'), '[tool.ruff.lint]\nselect = ["E"]\n')
    expect(await names()).toContain('python')
  })
})

describe('fix', () => {
  test('runs each fixer, prints one line each and the files they changed, not those already dirty', async () => {
    await repo()
    writeFileSync(join(dir, 'dirty.txt'), 'before\n')
    writeFileSync(join(dir, 'Makefile'), 'b:\n\ttrue\n\n\n\na:\n\ttrue\n')
    scripts({ 'lint:fix': 'echo fixed > a.ts' })

    const { result, out } = await capture(async () => fix([], dir))
    const lines = out.trimEnd().split('\n')

    expect(result).toBe(0)
    expect(lines[0]).toMatch(/^ok {4}lint:fix {2}\d+\.\ds {2}\S+fix-lint-fix\.log$/)
    expect(lines[1]).toStartWith('ok    makefile')
    expect(lines.slice(2).sort()).toEqual(['  Makefile', '  a.ts', 'changed 2 files:'].sort())
    expect(await Bun.file(join(dir, 'Makefile')).text()).toBe('.PHONY: a b\n\nb:\n\ttrue\n\na:\n\ttrue\n')
  })

  test('leaves a Makefile that is already declared untouched', async () => {
    await repo()
    writeFileSync(join(dir, 'Makefile'), '.PHONY: a\n\na:\n\ttrue\n')

    const before = statSync(join(dir, 'Makefile')).mtimeMs

    await Bun.sleep(20)

    const { result, out } = await capture(async () => fix([], dir))

    expect(result).toBe(0)
    expect(out).toContain('nothing changed')
    expect(statSync(join(dir, 'Makefile')).mtimeMs).toBe(before)
  })

  test('--timeout ends a fixer and exits 2', async () => {
    await repo()
    scripts({ fix: 'sleep 30 & wait' })

    const { result, out } = await capture(async () => fix(['--timeout', '1s'], dir))

    expect(result).toBe(2)
    expect(out).toContain('TIME  fix')
  })

  test('--json prints each fixer\'s outcome and the files changed', async () => {
    await repo()
    scripts({ 'lint:fix': 'echo fixed > a.ts' })

    const { result, out } = await capture(async () => fix(['--json'], dir))
    const printed = JSON.parse(out) as { fixers: { name: string, ok: boolean }[], changed: string[] }

    expect(result).toBe(0)
    expect(printed.fixers.map(fixer => [fixer.name, fixer.ok])).toEqual([['lint:fix', true]])
    expect(printed.changed).toEqual(['a.ts'])
  })

  test('a failing fixer prints what it said and fails the run', async () => {
    scripts({ format: 'echo cannot parse src/a.ts && exit 3' })

    const { result, out } = await capture(async () => fix([], dir))

    expect(result).toBe(1)
    expect(out).toContain('FAIL  format')
    expect(out).toContain('  cannot parse src/a.ts')
    expect(out).not.toContain('changed')
  })

  // The CI image has no just.
  test.skipIf(Bun.which('just') === null)('formats the folder\'s own justfile only, not a parent\'s', async () => {
    const sub = join(dir, 'sub')

    mkdirSync(sub)
    writeFileSync(join(dir, 'justfile'), 'a:\n  echo a\n')
    writeFileSync(join(sub, 'justfile'), 'b:\n  echo b\n')

    expect((await capture(async () => fix([], sub))).result).toBe(0)
    expect(await Bun.file(join(sub, 'justfile')).text()).toBe('b:\n    echo b\n')
    expect(await Bun.file(join(dir, 'justfile')).text()).toBe('a:\n  echo a\n')
  })

  test('--list prints without running, --only picks', async () => {
    scripts({ 'lint:fix': 'echo ran > ran.txt', 'format': 'x' })

    expect((await capture(async () => fix(['--list'], dir))).out).toContain('lint:fix  bun run lint:fix  package.json')
    expect(await Bun.file(join(dir, 'ran.txt')).exists()).toBe(false)

    const { out } = await capture(async () => fix(['--only', 'lint:fix'], dir))

    expect(out).not.toContain('format')
    expect(await Bun.file(join(dir, 'ran.txt')).exists()).toBe(true)
  })

  test('refuses to run under a fixer, which would recurse, and fails where nothing applies', async () => {
    expect(await failure(fix([], dir))).toContain('nothing to fix here')

    process.env.AGENT_TOOLS_FIX = '1'

    try {
      expect(await failure(fix([], dir))).toContain('would recurse')
    }
    finally {
      delete process.env.AGENT_TOOLS_FIX
    }
  })
})

describe('changedFiles', () => {
  test('reports nothing outside a repository', async () => {
    expect(await dirtyFiles(dir)).toBeUndefined()
  })

  test('names new and rewritten files', async () => {
    await repo()
    writeFileSync(join(dir, 'same.txt'), 'x\n')

    const before = (await dirtyFiles(dir))!

    writeFileSync(join(dir, 'new.txt'), 'new\n')

    expect(changedFiles(before, (await dirtyFiles(dir))!)).toEqual(['new.txt'])
  })
})
