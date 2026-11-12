import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fillTemplate, resolveConfig } from '../src/config'
import { tasksDir } from '../src/project'
import { shellWrapper } from '../src/shell'

describe('resolveConfig', () => {
  test('puts the jobs under the state folder, wherever that is, and expands a leading ~', () => {
    const settings = resolveConfig({ state: '~/state' })

    expect(settings.state).toBe(join(homedir(), 'state'))
    expect(settings.jobs).toBe(join(homedir(), 'state', 'jobs'))
    expect(settings.proxyNetwork).toBe('proxy')
    expect(settings.runner).toEqual({})
  })

  test('keeps the folders it is given', () => {
    const settings = resolveConfig({ jobs: '/j', overrides: '/o', manifests: '/m' })

    expect(settings).toMatchObject({ jobs: '/j', overrides: '/o', manifests: '/m' })
  })
})

describe('fillTemplate', () => {
  test('fills the placeholders it knows and leaves the others', () => {
    expect(fillTemplate(['up', '{project}/{task}', '{other}'], { project: 'times', task: 'planning' })).toEqual(['up', 'times/planning', '{other}'])
  })
})

describe('tasksDir', () => {
  test('puts the worktrees beside the checkout by default, under the folder the config names otherwise', () => {
    const project = { name: 'times', root: '/w/times', repos: [], routes: [] }

    expect(tasksDir({ ...project, settings: resolveConfig() })).toBe('/w/.worktrees/times')
    expect(tasksDir({ ...project, settings: resolveConfig({ worktrees: '/trees/{repo}' }) })).toBe('/trees/times')
  })
})

describe('shellWrapper', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wt-shell-'))
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'there'))
    // A wt answering `path` alone, logging every other call
    writeFileSync(join(dir, 'bin', 'wt'), `#!/bin/sh\n[ "$1" = path ] && { echo ${join(dir, 'there')}; exit 0; }\necho "wt $*" >> ${join(dir, 'calls')}\n`, { mode: 0o755 })
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test.each(['fish', 'bash', 'zsh'])('wraps %s with its completion inline', (shell) => {
    const wrapper = shellWrapper(shell)

    expect(wrapper).toContain('__kaynooo_cli_complete')
    expect(wrapper).not.toContain('--completions fish |')
  })

  // Run only where the shell is installed, reported as skipped elsewhere
  for (const shell of ['fish', 'bash', 'zsh']) {
    test.skipIf(Bun.which(shell) === null)(`${shell} reads its wrapper without running anything, and cd goes where wt path says`, () => {
      const file = join(dir, `wt.${shell}`)

      writeFileSync(file, shellWrapper(shell))

      const script = shell === 'fish' ? `source ${file}; wt cd planning; and pwd` : `source ${file}; wt cd planning && pwd`
      const run = Bun.spawnSync([shell, '-c', script], { env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir } })

      expect(run.stdout.toString()).toBe(`${join(dir, 'there')}\n`)
      expect(existsSync(join(dir, 'calls'))).toBe(false)
    })
  }

  test('names the shells it has a wrapper for when asked for another', () => {
    expect(() => shellWrapper('nu')).toThrow('no wrapper for nu, only fish, bash, zsh')
  })
})
