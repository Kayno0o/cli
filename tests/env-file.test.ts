import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const SHEBANG = /^#!\/usr\/bin\/env (?:-S )?bun(?: --no-env-file)?$/
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
