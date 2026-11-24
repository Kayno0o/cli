import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { exec, pull, push } from '../src/ops'

const temp = tempDirs()

async function initPair(root: string, name: string): Promise<{ origin: string, work: string, other: string }> {
  const origin = join(root, `${name}.git`)
  const work = join(root, name)
  const other = join(root, `other-${name}`)

  await $`git init -q --bare -b main ${origin} && git clone -q ${origin} ${work}`.quiet()
  await $`git -C ${work} config user.name t && git -C ${work} config user.email t@t`.quiet()
  await Bun.write(join(work, 'a.txt'), 'v1\n')
  await $`git -C ${work} add a.txt && git -C ${work} commit -q -m init && git -C ${work} push -q -u origin main`.quiet()
  await $`git clone -q ${origin} ${other}`.quiet()
  await $`git -C ${other} config user.name t && git -C ${other} config user.email t@t`.quiet()

  return { origin, work, other }
}

describe('ws pull, push, and exec', () => {
  test('ws pull fast-forwards behind repos and --dirty safely stashes and restores dirty repos', async () => {
    const root = temp('ws-ops-')
    const workspace = join(root, 'ws')

    await $`mkdir -p ${workspace}`.quiet()

    const { work, other } = await initPair(root, 'app')

    await $`mv ${work} ${join(workspace, 'app')}`.quiet()
    await Bun.write(join(other, 'remote.txt'), 'from remote\n')
    await $`git -C ${other} add remote.txt && git -C ${other} commit -q -m remote && git -C ${other} push -q origin main`.quiet()

    // Make local repo dirty with an untracked/modified file.
    await Bun.write(join(workspace, 'app', 'local.txt'), 'wip\n')

    const skippedRes = await capture(async () => pull([workspace, '--json']))
    const skippedJson = JSON.parse(skippedRes.out) as { action: string }[]

    expect(skippedRes.result).toBe(0)
    expect(skippedJson[0]?.action).toBe('skipped')

    const dirtyRes = await capture(async () => pull([workspace, '--dirty', '--prune', '--json']))
    const dirtyJson = JSON.parse(dirtyRes.out) as { action: string }[]

    expect(dirtyRes.result).toBe(0)
    expect(dirtyJson[0]?.action).toBe('pulled')
    expect(await Bun.file(join(workspace, 'app', 'remote.txt')).text()).toBe('from remote\n')
    expect(await Bun.file(join(workspace, 'app', 'local.txt')).text()).toBe('wip\n')
  })

  test('ws push pushes ahead repos and ws exec runs a command across repos', async () => {
    const root = temp('ws-push-exec-')
    const workspace = join(root, 'ws')

    await $`mkdir -p ${workspace}`.quiet()

    const { work } = await initPair(root, 'lib')

    await $`mv ${work} ${join(workspace, 'lib')}`.quiet()
    await Bun.write(join(workspace, 'lib', 'next.txt'), 'next\n')
    await $`git -C ${join(workspace, 'lib')} add next.txt && git -C ${join(workspace, 'lib')} commit -q -m next`.quiet()

    const pushed = await capture(async () => push([workspace, '--json']))
    const pushJson = JSON.parse(pushed.out) as { action: string }[]

    expect(pushed.result).toBe(0)
    expect(pushJson).toMatchObject([{ repo: 'lib', action: 'pushed' }])

    const ran = await capture(async () => exec([workspace, '--json', '--', 'git', 'rev-parse', '--abbrev-ref', 'HEAD']))
    const execJson = JSON.parse(ran.out) as { repo: string, code: number, stdout: string }[]

    expect(ran.result).toBe(0)
    expect(execJson).toMatchObject([{ repo: 'lib', code: 0 }])
    expect(execJson[0]?.stdout.trim()).toBe('main')
  })
})
