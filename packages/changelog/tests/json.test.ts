import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, it } from 'bun:test'
import { releasedRepo } from './fixture'

const CLI = join(import.meta.dir, '../src/cli.ts')
const tempDir = tempDirs()

// A released repo with no origin, so nothing reaches a remote, run with no token.
async function repo(): Promise<string> {
  const { dir } = await releasedRepo(tempDir('changelog-json-'))

  await $`git remote remove origin`.cwd(dir).quiet()

  return dir
}

async function run(cwd: string, args: string[]) {
  const proc = Bun.spawn(['bun', CLI, ...args], { cwd, env: { ...process.env, GITHUB_TOKEN: '' }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

  return { out, err, code }
}

describe('changelog release --json', () => {
  it('prints the dry-run notes as the only thing on stdout, the progress on stderr', async () => {
    const { out, err, code } = await run(await repo(), ['--dry-run', '--json', '--repo', 'o/r'])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ command: 'release', status: 'dry-run', from: 'v1.4.2', commits: 3, url: null, output: null, assetsFailed: 0, discord: null })
    expect((JSON.parse(out) as { notes: string }).notes).toContain('Upload to forgejo using bun')
    expect(err).toContain('Dry run')
  })

  it('reports a note saved with --output', async () => {
    const dir = await repo()
    const { out, code } = await run(dir, ['--json', '--repo', 'o/r', '--output', join(dir, 'notes.md')])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ status: 'saved', output: join(dir, 'notes.md') })
    expect(await Bun.file(join(dir, 'notes.md')).text()).toContain('Upload to forgejo using bun')
  })

  it('fails as {error} on stderr with nothing on stdout', async () => {
    const { out, err, code } = await run(await repo(), ['--json', '--repo', 'o/r'])

    expect(code).toBe(1)
    expect(out).toBe('')
    expect(JSON.parse(err.trim().split('\n').at(-1) ?? '')).toMatchObject({ error: expect.stringContaining('no Forgejo token') })
  })
})

describe('changelog undo --json', () => {
  it('lists what a dry run would remove', async () => {
    const { out, code } = await run(await repo(), ['undo', 'v1.4.2', '--dry-run', '--json', '--repo', 'o/r'])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ command: 'undo', status: 'dry-run', tag: 'v1.4.2', releaseNote: false, remoteTag: false, localTag: true, commitReset: null })
  })

  it('undoes with --yes and says so', async () => {
    const dir = await repo()
    const { out, code } = await run(dir, ['undo', 'v1.4.2', '--yes', '--json', '--repo', 'o/r'])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ status: 'undone', tag: 'v1.4.2', localTag: true })
    expect((await $`git tag -l v1.4.2`.cwd(dir).text()).trim()).toBe('')
  })

  it('reports nothing to undo', async () => {
    const { out, code } = await run(await repo(), ['undo', 'v9.9.9', '--json', '--repo', 'o/r'])

    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ command: 'undo', status: 'nothing', tag: 'v9.9.9' })
  })

  it('refuses to ask a question, as {error} with exit 2', async () => {
    const { out, err, code } = await run(await repo(), ['undo', 'v1.4.2', '--json', '--repo', 'o/r'])

    expect(code).toBe(2)
    expect(out).toBe('')
    expect(JSON.parse(err.trim().split('\n').at(-1) ?? '')).toMatchObject({ error: expect.stringContaining('--yes') })
  })
})
