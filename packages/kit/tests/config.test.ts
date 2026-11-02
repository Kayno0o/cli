import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { findUp, loadConfig } from '../src/config'
import { tempDirs } from '../src/test'

const temp = tempDirs()

// What a promise rejects with, undefined when it resolves.
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }

  return undefined
}

// A fresh folder holding `files`, nested folders created along.
function folder(files: Record<string, string> = {}): string {
  const root = realpathSync(temp('kit-config-'))

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }

  return root
}

describe('findUp', () => {
  it('finds the nearest file walking up, the first name winning within a folder', () => {
    const root = folder({ 'demo.config.json': '{}', 'a/demo.config.ts': '', 'a/demo.config.json': '{}', 'a/b/c/.keep': '' })

    expect(findUp(['demo.config.ts', 'demo.config.json'], join(root, 'a/b/c'))).toBe(join(root, 'a/demo.config.ts'))
    expect(findUp('demo.config.json', join(root, 'a/b'))).toBe(join(root, 'a/demo.config.json'))
  })

  it('answers undefined with none up to the root', () => {
    expect(findUp('no-such-kit-config.ts', folder())).toBeUndefined()
  })
})

describe('config search bounds', () => {
  it('stops at the git root and never reads a config above it', async () => {
    const root = folder({ 'demo.config.ts': 'export default 1', 'repo/.git/HEAD': '', 'repo/src/.keep': '' })

    expect(await loadConfig('demo.config.ts', { from: join(root, 'repo/src') })).toBeUndefined()
  })

  it('finds a config in the git root itself', async () => {
    const root = folder({ 'repo/demo.config.ts': 'export default 1', 'repo/.git/HEAD': '', 'repo/src/.keep': '' })

    expect((await loadConfig('demo.config.ts', { from: join(root, 'repo/src') }))?.config).toBe(1)
  })
})

describe('loadConfig', () => {
  it('imports the default export of the config found, with its folder', async () => {
    const root = folder({ 'demo.config.ts': 'export default { port: 3000 }', 'src/.keep': '' })

    expect(await loadConfig('demo.config.ts', { from: join(root, 'src') })).toEqual({ path: join(root, 'demo.config.ts'), dir: root, config: { port: 3000 } })
  })

  it('reads a JSON config as its object', async () => {
    const root = folder({ 'demo.json': '{ "port": 3000 }' })

    expect((await loadConfig('demo.json', { from: root }))?.config).toEqual({ port: 3000 })
  })

  it('reads the file a path names instead of searching, resolved against from', async () => {
    const root = folder({ 'demo.config.ts': 'export default 1', 'other/named.ts': 'export default 2' })

    expect((await loadConfig('demo.config.ts', { from: root, path: 'other/named.ts' }))?.config).toBe(2)
  })

  it('answers undefined with no config to find', async () => {
    expect(await loadConfig('no-such-kit-config.ts', { from: folder() })).toBeUndefined()
  })

  it('fails with exit 1 on a named file missing, one failing to import, or one without a default export', async () => {
    const root = folder({ 'broken.ts': 'export default {', 'bare.ts': 'export const port = 1' })

    expect(await thrown(loadConfig('x', { from: root, path: 'gone.ts' }))).toMatchObject({ code: 1, message: `no file ${join(root, 'gone.ts')}` })
    expect(await thrown(loadConfig('broken.ts', { from: root }))).toMatchObject({ code: 1, message: expect.stringContaining(`${join(root, 'broken.ts')} does not load: `) })
    expect(await thrown(loadConfig('bare.ts', { from: root }))).toMatchObject({ code: 1, message: `${join(root, 'bare.ts')} has no default export` })
  })
})
