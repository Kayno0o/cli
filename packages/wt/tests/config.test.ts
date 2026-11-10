import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
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
  test('wraps fish, and names the shells it has no wrapper for', () => {
    expect(shellWrapper('fish')).toContain('builtin cd $dir')
    expect(() => shellWrapper('bash')).toThrow('no wrapper for bash yet, only fish')
  })
})
