import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { release } from '../src/commands/release'
import { registryWait } from '../src/commands/release-steps'
import { timing } from '../src/commands/watch'
import { withFakeTea } from './fake-tea'

const temp = tempDirs()

// Every commit of the repo starts a run on it, ending as HOOK_RUN_STATUS says, as the forge does for a push.
const HOOK = `#!/usr/bin/env bun
const file = process.env.FAKE_TEA_STATE
const state = await Bun.file(file).json()
const sha = (await Bun.$\`git rev-parse HEAD\`.text()).trim()

state.runs.push({ id: 10 + state.runs.length, commit_sha: sha, event: 'push', status: process.env.HOOK_RUN_STATUS, workflow_id: 'test.yml', prettyref: 'main', html_url: 'https://forge/runs/new', title: 'bump', duration: 60e9 })
await Bun.write(file, JSON.stringify(state))
`

// Collects what the command printed on stdout, which a throwing capture would lose.
async function logging<T>(into: unknown[], body: () => Promise<T>): Promise<T> {
  const spy = spyOn(console, 'log')

  try {
    return await body()
  }
  finally {
    into.push(...spy.mock.calls.map((call: unknown[]) => call[0]))
    spy.mockRestore()
  }
}

describe('release --json', () => {
  const poll = timing.poll
  const home = process.cwd()
  const saved = { status: process.env.HOOK_RUN_STATUS, registry: process.env.BUN_CONFIG_REGISTRY, tries: registryWait.tries, wait: registryWait.poll }

  beforeEach(() => {
    timing.poll = 1
    process.env.HOOK_RUN_STATUS = 'success'
  })

  afterEach(() => {
    timing.poll = poll
    registryWait.tries = saved.tries
    registryWait.poll = saved.wait
    process.chdir(home)

    if (saved.status === undefined)
      Reflect.deleteProperty(process.env, 'HOOK_RUN_STATUS')
    else
      process.env.HOOK_RUN_STATUS = saved.status

    if (saved.registry === undefined)
      Reflect.deleteProperty(process.env, 'BUN_CONFIG_REGISTRY')
    else
      process.env.BUN_CONFIG_REGISTRY = saved.registry
  })

  // A workspace of the packages a and b, pushed, with the run that already passed on its commit.
  async function workspace(): Promise<{ work: string, runs: Record<string, unknown>[] }> {
    const root = temp('ft-release-json-')
    const work = join(root, 'work')

    await $`git init -q --bare -b main ${root}/origin.git && git clone -q ${root}/origin.git ${work}`.quiet()
    await Bun.write(join(work, 'package.json'), JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }))
    await Bun.write(join(work, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'ft-json-a', version: '1.0.0' }))
    await Bun.write(join(work, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'ft-json-b', version: '2.0.0' }))
    await $`bun install && git config user.name t && git config user.email t@t && git add . && git commit -q -m init && git push -q origin main`.cwd(work).quiet()
    await Bun.write(join(work, '.git', 'hooks', 'post-commit'), HOOK)
    await chmod(join(work, '.git', 'hooks', 'post-commit'), 0o755)

    const sha = (await $`git rev-parse HEAD`.cwd(work).text()).trim()

    return { work, runs: [{ id: 1, commit_sha: sha, event: 'push', status: 'success', workflow_id: 'test.yml', prettyref: 'main', html_url: 'https://forge/runs/1', title: 'init', duration: 60e9 }] }
  }

  test('prints one released result on stdout and the progress on stderr', async () => {
    const { work, runs } = await workspace()

    process.chdir(work)
    await withFakeTea({ issues: [], runs }, async () => {
      const { result, out, err } = await capture(async () => release(['patch', '-p', 'a', '--no-registry', '--json']))
      const printed = JSON.parse(out) as Record<string, unknown>

      expect(result).toBe(0)
      expect(printed).toMatchObject({ released: true, tag: 'a-v1.0.1', package: 'ft-json-a', version: '1.0.1', status: 'success' })
      expect(printed.runs).toHaveLength(1)
      expect(err).toContain('pushed main and a-v1.0.1, waiting for their runs')
    })
  })

  test('a failing run prints released false with the run and exits 1', async () => {
    const { work, runs } = await workspace()

    process.env.HOOK_RUN_STATUS = 'failure'
    process.chdir(work)
    await withFakeTea({ issues: [], runs }, async () => {
      const { result, out } = await capture(async () => release(['patch', '-p', 'a', '--no-registry', '--json']))

      expect(result).toBe(1)
      expect(JSON.parse(out)).toMatchObject({ released: false, tag: 'a-v1.0.1', status: 'failure', url: 'https://forge/runs/new' })
    })
  })

  test('several packages print an array of their results', async () => {
    const { work, runs } = await workspace()

    process.chdir(work)
    await withFakeTea({ issues: [], runs }, async () => {
      const { result, out } = await capture(async () => release(['patch', '-p', 'a,b:minor', '--no-registry', '--json']))
      const printed = JSON.parse(out) as { released: boolean, tag: string }[]

      expect(result).toBe(0)
      expect(printed.map(each => [each.released, each.tag])).toEqual([[true, 'a-v1.0.1'], [true, 'b-v2.1.0']])
    })
  })

  async function registryRefusing(args: string[]): Promise<unknown[]> {
    const { work, runs } = await workspace()
    const printed: unknown[] = []

    process.chdir(work)
    process.env.BUN_CONFIG_REGISTRY = 'http://127.0.0.1:9'
    registryWait.tries = 1
    registryWait.poll = 1

    await withFakeTea({ issues: [], runs }, async () => {
      // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
      await expect(capture(async () => logging(printed, async () => release(args)))).rejects.toThrow('the registry does not serve ft-json-a@1.0.1')
    })

    return printed.map(each => JSON.parse(String(each)) as unknown)
  }

  test('a registry that never serves the version still prints released false with the tag', async () => {
    expect(await registryRefusing(['patch', '-p', 'a', '--json'])).toMatchObject([{ released: false, tag: 'a-v1.0.1', status: 'success' }])
  })

  test('a package throwing in a several-package run prints the results so far before the error', async () => {
    expect(await registryRefusing(['patch', '-p', 'a,b', '--json'])).toMatchObject([[{ released: false, tag: 'a-v1.0.1' }]])
  })
})
