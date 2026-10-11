import { $ } from 'bun'
import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGitDiff } from '../src/changelog'

const dir = await mkdtemp(join(tmpdir(), 'changelogitea-first-parent-'))
const git = (...args: string[]) => $`git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false ${args}`.cwd(dir).quiet()

async function commit(file: string, message: string) {
  await writeFile(join(dir, file), message)
  await git('add', file)
  await git('commit', '-m', message)
}

afterAll(() => rm(dir, { recursive: true, force: true }))

it('lists a merge on its own with firstParent, and its imported commits without', async () => {
  await git('init', '-b', 'main')
  await commit('a.txt', 'feat: main commit')
  await git('checkout', '--orphan', 'other')
  await git('rm', '-rf', '.')
  await commit('b.txt', 'feat: imported one')
  await commit('c.txt', 'feat: imported two')
  await git('checkout', 'main')
  await git('merge', '--allow-unrelated-histories', '--no-ff', '-m', 'feat: merge other', 'other')

  const cwd = process.cwd()

  process.chdir(dir)

  try {
    const messages = async (firstParent: boolean) => (await getGitDiff(undefined, 'HEAD', firstParent)).map(c => c.message)
    const flat = await messages(true)
    const all = await messages(false)

    expect(flat).toContain('feat: merge other')
    expect(flat).not.toContain('feat: imported one')
    expect(flat).not.toContain('feat: imported two')
    expect(all).toContain('feat: merge other')
    expect(all).toContain('feat: imported one')
    expect(all).toContain('feat: imported two')
  }
  finally {
    process.chdir(cwd)
  }
})
