import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { capture } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ci } from '../src/commands/ci'
import { withFakeTea } from './fake-tea'

let root = ''
let clone = ''
let sha = ''
const home = process.cwd()

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ft-ci-json-')))
  clone = join(root, 'clone')
  await $`git init -q --bare -b main ${join(root, 'origin.git')} && git clone -q ${join(root, 'origin.git')} ${clone}`.cwd(root).quiet()
  await $`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m one && git push -q origin main && git remote set-head origin -a`.cwd(clone).quiet()
  sha = (await $`git rev-parse HEAD`.cwd(clone).text()).trim()
})

afterAll(async () => {
  process.chdir(home)
  await rm(root, { recursive: true, force: true })
})

const run = (id: number, status: string) => ({ id, commit_sha: sha, event: 'push', status, workflow_id: 'test.yml', prettyref: 'main', html_url: `https://forge/runs/${id}`, title: 'x' })

describe('ft ci --json', () => {
  test('prints the failed run\'s jobs on stdout, announcing on stderr', async () => {
    process.chdir(clone)

    let code = -1
    const { out, err } = await capture(async () => withFakeTea({ issues: [], runs: [run(3, 'failure')], jobs: { 3: [{ id: 30, name: 'test', status: 'failure', runs_on: null }] }, logs: { 30: 'it broke' } }, async () => {
      code = await ci(['--json'])
    }))

    expect(code).toBe(1)
    expect(JSON.parse(out)).toEqual({
      status: 'failure',
      runs: [{ id: 3, workflow: 'test.yml', status: 'failure', ref: 'main', sha, url: 'https://forge/runs/3' }],
      failedJobs: [{ name: 'test', run: 3, workflow: 'test.yml', excerpt: 'it broke' }],
      url: 'https://forge/runs/3',
    })
    expect(err).toContain('following test.yml run 3')
    expect(err).not.toContain('it broke')
  })

  test('passes with no failed job', async () => {
    process.chdir(clone)

    let code = -1
    const { out } = await capture(async () => withFakeTea({ issues: [], runs: [run(4, 'success')] }, async () => {
      code = await ci(['--json'])
    }))

    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ status: 'success', failedJobs: [], url: 'https://forge/runs/4' })
  })
})

describe('ft ci --quiet', () => {
  test('prints the announcement, the failure and the result, nothing else', async () => {
    process.chdir(clone)

    const { out } = await capture(async () => withFakeTea({ issues: [], runs: [run(5, 'success')] }, async () => ci(['--quiet'])))

    expect(out.trim().split('\n')).toEqual([`following test.yml run 5 on ${sha.slice(0, 7)}: https://forge/runs/5`, `CI passed on ${sha.slice(0, 7)}`])
  })
})
