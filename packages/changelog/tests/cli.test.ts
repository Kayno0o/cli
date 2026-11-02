import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, it } from 'bun:test'
import { version } from '../package.json'

const CLI = join(import.meta.dir, '../src/cli.ts')
const tempDir = tempDirs()

async function run(args: string[], cwd = import.meta.dir) {
  const proc = Bun.spawn(['bun', CLI, ...args], { cwd, env: { ...process.env, GITHUB_TOKEN: 'none' }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

  return { out, err, code }
}

describe('cli', () => {
  it('lists its commands with --help', async () => {
    const { out, code } = await run(['--help'])

    expect(code).toBe(0)
    expect(out).toContain('release')
    expect(out).toContain('undo')
  })

  it('prints the version', async () => {
    expect(await run(['--version'])).toMatchObject({ out: `${version}\n`, code: 0 })
    expect(await run(['-v'])).toMatchObject({ out: `${version}\n`, code: 0 })
  })

  it('documents the release flags on the default command', async () => {
    const { out, code } = await run(['release', '--help'])

    expect(code).toBe(0)
    expect(out).toContain('--first-parent')
    expect(out).not.toContain('--yes')
  })

  it('exits 2 on an unknown flag', async () => {
    const { err, code } = await run(['--nope'])

    expect(code).toBe(2)
    expect(err).toContain('changelog release: unknown option')
  })

  it('exits 2 on a stray argument', async () => {
    expect((await run(['bogus'])).code).toBe(2)
    expect((await run(['undo', 'v1', 'v2'])).code).toBe(2)
  })

  it('dispatches undo with its own flags', async () => {
    const help = await run(['undo', '--help'])

    expect(help.code).toBe(0)
    expect(help.out).toContain('--yes')
    expect(help.out).toContain('--note')
    expect((await run(['undo', '--bogus'])).code).toBe(2)
  })

  it('exits 1 when undo fails outside a git repo', async () => {
    const dir = tempDir('changelog-cli-')

    expect((await run(['undo'], dir)).code).toBe(1)
  })
})
