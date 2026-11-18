import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { shellShebang } from '../scripts/shell-shebang'

const ROOT = new URL('..', import.meta.url).pathname
const SHEBANG = /^#!\/usr\/bin\/env -S bun(?: --no-env-file)? --config=\/dev\/null$/
// These two read their own settings from the cwd's .env, so Bun keeps loading it for them.
const READS_DOT_ENV = new Set(['db', 'changelog'])

const entries = readdirSync(`${ROOT}packages`).flatMap(dir =>
  readdirSync(`${ROOT}packages/${dir}/src`, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => ({ dir, path: `${ROOT}packages/${dir}/src/${file}` }))
    .filter(({ path }) => readFileSync(path, 'utf8').startsWith('#!')))

const folder = mkdtempSync(join(tmpdir(), 'kaynooo-cli-env-'))

afterAll(() => rmSync(folder, { recursive: true, force: true }))

// A bin that runs another command must not hand it the cwd's .env, which Bun loads into the bin's own environment otherwise and which then beats the child's --env-file.
describe('a bin does not load the cwd .env', () => {
  for (const { dir, path } of entries) {
    test(`${path.slice(ROOT.length)} starts with --no-env-file`, () => {
      const shebang = readFileSync(path, 'utf8').split('\n').at(0) ?? ''

      expect(SHEBANG.test(shebang)).toBe(true)
      expect(shebang.includes('--no-env-file')).toBe(!READS_DOT_ENV.has(dir))
    })
  }

  test('slot leaves the keys of the .env out of its command', () => {
    writeFileSync(join(folder, '.env'), 'KAYNOOO_CLI_LEAK=from-dot-env\n')

    // Bun runs the shebang's flags the same way when the file is started directly.
    const run = Bun.spawnSync([process.execPath, '--no-env-file', `${ROOT}packages/wait/src/slot-cli.ts`, '--', 'sh', '-c', 'printenv KAYNOOO_CLI_LEAK || echo unset'], { cwd: folder, env: { ...process.env, KAYNOOO_CLI_LEAK: undefined }, stdout: 'pipe', stderr: 'pipe' })

    expect(run.stdout.toString().trim()).toBe('unset')
  })
})

// A bunfig.toml in the cwd must not reach a bin: one that preloads a file the bin cannot load would kill it before it ran.
describe('a bin does not load the cwd bunfig.toml', () => {
  test('slot runs in a folder whose bunfig.toml preloads a missing file', () => {
    writeFileSync(join(folder, 'bunfig.toml'), 'preload = ["./missing-plugin.ts"]\n')

    const run = Bun.spawnSync([process.execPath, '--no-env-file', '--config=/dev/null', `${ROOT}packages/wait/src/slot-cli.ts`, '--', 'echo', 'ran'], { cwd: folder, stdout: 'pipe', stderr: 'pipe' })

    expect(run.stdout.toString().trim()).toBe('ran')
  })
})

// BusyBox env, the Alpine CI image's, has no -S, so a built bin starts through sh instead (#339).
describe('a built bin starts on a plain sh', () => {
  test('the env shebang becomes sh handing the file to Bun with its flags, on Bun\'s own pragma line when the build wrote one', () => {
    expect(shellShebang('#!/usr/bin/env -S bun --no-env-file --config=/dev/null\n// @bun\nconsole.log(1)\n')).toBe('#!/bin/sh\n// @bun 2>/dev/null; exec bun --no-env-file --config=/dev/null "$0" "$@"\nconsole.log(1)\n')
    expect(shellShebang('#!/usr/bin/env -S bun --config=/dev/null\nconsole.log(1)\n')).toBe('#!/bin/sh\n// 2>/dev/null; exec bun --config=/dev/null "$0" "$@"\nconsole.log(1)\n')
    expect(shellShebang('// a chunk\nexport {}\n')).toBeUndefined()
  })


  test('a built slot run by its path ignores the cwd bunfig.toml and passes its arguments as given', () => {
    const out = mkdtempSync(join(tmpdir(), 'kaynooo-cli-bin-'))

    try {
      expect(Bun.spawnSync([process.execPath, 'build', `${ROOT}packages/wait/src/slot-cli.ts`, '--target', 'bun', '--outdir', out]).exitCode).toBe(0)
      expect(Bun.spawnSync([process.execPath, `${ROOT}scripts/shell-shebang.ts`, out]).exitCode).toBe(0)
      chmodSync(join(out, 'slot-cli.js'), 0o755)
      writeFileSync(join(folder, 'bunfig.toml'), 'preload = ["./missing-plugin.ts"]\n')

      const run = Bun.spawnSync([join(out, 'slot-cli.js'), '--', 'printf', '[%s]', 'a b', '$HOME'], { cwd: folder, stdout: 'pipe', stderr: 'pipe' })

      expect({ out: run.stdout.toString(), err: run.stderr.toString() }).toEqual({ out: '[a b][$HOME]', err: '' })
    }
    finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)
})
