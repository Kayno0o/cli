import type { Entry } from '../src/jobs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { byRecency } from '@kaynooo/cli-kit/picker'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { everything, id, resolve, shortest, targets } from '../src/jobs'

const FILES: Record<string, string> = {
  '.git/HEAD': '',
  'justfile': 'check:\n    echo check\n\n# Build it\nbuild:\n    echo build\n',
  'package.json': JSON.stringify({ scripts: { 'check': 'tsc', 'lint:fix': 'eslint --fix .' }, workspaces: ['packages/*'] }),
  'bun.lock': '',
  'composer.json': JSON.stringify({ 'scripts': { test: ['phpunit'], cs: 'php-cs-fixer fix' }, 'scripts-descriptions': { test: 'Run the tests' } }),
  'Taskfile.yml': 'version: "3"\ntasks:\n  deploy:\n    desc: Deploy it\n    cmds:\n      - ./deploy.sh\n  helper:\n    internal: true\n    cmds: [echo]\n',
  'pyproject.toml': '[project.scripts]\ncli = "pkg.main:run"\n\n[tool.poe.tasks]\nfmt = "ruff format"\n_private = "echo"\n',
  'uv.lock': '',
  'deno.jsonc': '{\n  // tasks\n  "tasks": { "dev": "deno run main.ts", "serve": { "command": "deno serve", "description": "Serve it" } }\n}\n',
  'api/package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
  'api/package-lock.json': '{}',
  'api/Makefile': 'migrate: ## Run the migrations\n\tphp bin/console doctrine:migrations:migrate\n',
  'packages/a/package.json': JSON.stringify({ scripts: { build: 'tsup' } }),
  'node_modules/x/package.json': JSON.stringify({ scripts: { nope: 'x' } }),
  '.hidden/package.json': JSON.stringify({ scripts: { nope: 'x' } }),
  'empty/.keep': '',
}

const origin = process.cwd()
let root = ''
let found: Entry[] = []

const ids = () => found.map(entry => id(entry))
const byId = (wanted: string) => found.find(entry => id(entry) === wanted)!

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'job-pick-'))

  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  process.chdir(root)
  // Mise adds whatever global tasks this machine has, which say nothing about the fixture.
  found = everything().filter(entry => entry.kind !== 'mise')
})

afterAll(() => {
  process.chdir(origin)
  rmSync(root, { recursive: true, force: true })
})

describe('everything', () => {
  test('reads every kind of file of the folder', () => {
    expect(['just:check', 'just:build', 'bun:check', 'bun:lint:fix', 'composer:test', 'composer:cs', 'deno:dev', 'deno:serve', 'task:deploy', 'poe:fmt', 'uv:cli'].filter(wanted => !ids().includes(wanted))).toEqual([])
    expect(byId('just:build').doc).toBe('Build it')
    expect(byId('composer:test')).toMatchObject({ doc: 'Run the tests', separated: true, body: 'phpunit' })
    expect(byId('deno:serve')).toMatchObject({ doc: 'Serve it', body: 'deno serve', runner: ['deno', 'task'] })
    expect(byId('task:deploy')).toMatchObject({ doc: 'Deploy it', separated: true })
    expect(byId('poe:fmt').runner).toEqual(['uv', 'run', 'poe'])
  })

  test('leaves out the private and internal ones', () => {
    expect(ids()).not.toContain('task:helper')
    expect(ids()).not.toContain('poe:_private')
  })

  test('reads the child folders and the workspace packages, each with its own package manager', () => {
    expect(byId('npm:api/test')).toMatchObject({ dir: 'api', runner: ['npm', 'run'], separated: true })
    expect(byId('make:api/migrate')).toMatchObject({ dir: 'api', doc: 'Run the migrations' })
    expect(byId('bun:packages/a/build').dir).toBe('packages/a')
  })

  test('skips the hidden and installed folders', () => {
    expect(found.some(entry => entry.name === 'nope')).toBe(false)
  })

  test('finds the manifests of the parents from a folder holding none, no higher than the repository', () => {
    process.chdir(join(root, 'empty'))
    const above = everything()

    process.chdir(root)

    expect(above.find(entry => id(entry) === 'bun:../check')?.dir).toBe('..')
    expect(above.find(entry => id(entry) === 'composer:../test')).toBeDefined()
  })
})

describe('resolve', () => {
  test('offers every runner a name shares, and only the one it is qualified by', () => {
    expect(resolve(found, 'check').map(entry => id(entry))).toEqual(['just:check', 'bun:check'])
    expect(resolve(found, 'bun:check').map(entry => id(entry))).toEqual(['bun:check'])
  })

  test('takes the entry of this folder before the same name in a child one', () => {
    expect(resolve(found, 'test').map(entry => id(entry))).toEqual(['composer:test'])
    expect(resolve(found, 'api/test').map(entry => id(entry))).toEqual(['npm:api/test'])
  })

  test('reaches a child folder by name when this one has none', () => {
    expect(resolve(found, 'migrate').map(entry => id(entry))).toEqual(['make:api/migrate'])
  })

  test('reads a colon as part of the name when no runner goes by what comes before it', () => {
    expect(resolve(found, 'lint:fix').map(entry => id(entry))).toEqual(['bun:lint:fix'])
  })
})

describe('shortest', () => {
  test('qualifies a key only when another entry shares it', () => {
    expect(shortest(found, byId('composer:test'))).toBe('test')
    expect(shortest(found, byId('npm:api/test'))).toBe('api/test')
    expect(shortest(found, byId('just:check'))).toBe('just:check')
  })
})

describe('byRecency', () => {
  test('lists the entries run last first by their id', () => {
    const sorted = byRecency(found, [{ id: 'deno:dev', args: [] }, { id: 'just:build', args: [] }], id)

    expect(sorted.slice(0, 3).map(entry => id(entry))).toEqual(['deno:dev', 'just:build', 'just:check'])
  })
})

describe('targets', () => {
  test('reads the doc of a target from its trailing comment or the line above', () => {
    expect(targets('## Build it\nbuild:\n\tgo build\nclean: ## Clean up\n\trm -rf out\n.PHONY: build\n')).toEqual([
      { name: 'build', doc: 'Build it' },
      { name: 'clean', doc: 'Clean up' },
    ])
  })

  test('leaves variable assignments out, whatever the colon in their value', () => {
    expect(targets('IMAGE = registry:5000/x\nbuild:\n\tgo build\n')).toEqual([{ name: 'build', doc: null }])
  })
})

describe('everything with a broken manifest', () => {
  test('a malformed package.json in a child folder drops that folder only', () => {
    mkdirSync(join(root, 'broken'), { recursive: true })
    writeFileSync(join(root, 'broken/package.json'), '{ nope')

    const warned = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect(everything().some(entry => id(entry) === 'bun:check')).toBe(true)
      expect(warned.mock.calls.map(call => String(call[0])).some(line => line.includes('broken/package.json'))).toBe(true)
    }
    finally {
      warned.mockRestore()
      rmSync(join(root, 'broken'), { recursive: true, force: true })
    }
  })
})
