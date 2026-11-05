import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { tempDirs } from '../src/test'
import { saveWorkspace, workspaceChosen, workspaceRoot } from '../src/workspace-root'

const temp = tempDirs()

function home(config?: string) {
  const dir = temp('root-home-')

  if (config !== undefined) {
    mkdirSync(join(dir, '.config', 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(dir, '.config', 'kaynooo-cli', 'config.json'), config)
  }

  return dir
}

describe('workspaceRoot', () => {
  test('is ~/Workspace with nothing set', () => {
    const dir = home()

    expect(workspaceRoot({ home: dir, env: {} })).toBe(join(dir, 'Workspace'))
  })

  test('takes the config file, then the env var, then what was given', () => {
    const dir = home(JSON.stringify({ workspace: '~/code' }))

    expect(workspaceRoot({ home: dir, env: {} })).toBe(join(dir, 'code'))
    expect(workspaceRoot({ home: dir, env: { KAYNOOO_WORKSPACE: '/srv/repos' } })).toBe('/srv/repos')
    expect(workspaceRoot({ home: dir, env: { KAYNOOO_WORKSPACE: '/srv/repos' }, given: '/tmp/x' })).toBe('/tmp/x')
  })

  test('ignores an empty variable, a file that does not parse and a key that is no string', () => {
    expect(workspaceRoot({ home: home('{ nope'), env: { KAYNOOO_WORKSPACE: '' } })).toMatch(/\/Workspace$/)
    expect(workspaceRoot({ home: home(JSON.stringify({ workspace: 3 })), env: {} })).toMatch(/\/Workspace$/)
  })

  test('reads the file under XDG_CONFIG_HOME when that is set', () => {
    const xdg = temp('root-xdg-')

    mkdirSync(join(xdg, 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(xdg, 'kaynooo-cli', 'config.json'), JSON.stringify({ workspace: '/from/xdg' }))

    expect(workspaceRoot({ home: home(), env: { XDG_CONFIG_HOME: xdg } })).toBe('/from/xdg')
  })
})

describe('saveWorkspace', () => {
  test('writes the key, keeps the others and is seen as chosen', () => {
    const dir = home(JSON.stringify({ other: 1 }))

    expect(workspaceChosen({ home: dir, env: {} })).toBe(false)
    expect(saveWorkspace('~/code', { home: dir, env: {} })).toBe(true)
    expect(workspaceChosen({ home: dir, env: {} })).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, '.config', 'kaynooo-cli', 'config.json'), 'utf8'))).toEqual({ other: 1, workspace: '~/code' })
  })

  test('creates the file, and refuses to overwrite one that does not parse', () => {
    const fresh = home()
    const broken = home('{ nope')

    expect(saveWorkspace('/srv', { home: fresh, env: {} })).toBe(true)
    expect(workspaceRoot({ home: fresh, env: {} })).toBe('/srv')
    expect(saveWorkspace('/srv', { home: broken, env: {} })).toBe(false)
  })
})
