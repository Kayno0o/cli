import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { listFiles } from '../src/files'

const temp = tempDirs()

describe('listFiles outside a repository', () => {
  const dir = temp('code-files-')

  for (const path of ['src/a.ts', 'src/deep/b.ts', 'README.md', 'node_modules/x/index.js', '.cache/c.ts', 'dist/d.js', 'build/e.js', 'vendor/f.php', 'target/g.rs', 'coverage/h.json']) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), '')
  }

  test('walks the folder, leaving dependency, build and dot folders out', async () => {
    expect(await listFiles([], dir)).toEqual(['README.md', 'src/a.ts', 'src/deep/b.ts'])
  })

  test('walks only the paths given, a file kept as it is', async () => {
    expect(await listFiles(['src/deep', 'README.md', 'missing'], dir)).toEqual(['README.md', 'src/deep/b.ts'])
  })
})

describe('listFiles with an ignore config', () => {
  test('leaves the folders named in config.json out too', async () => {
    const home = temp('code-files-home-')
    const dir = temp('code-files-')
    const before = process.env.XDG_CONFIG_HOME

    mkdirSync(join(home, 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(home, 'kaynooo-cli', 'config.json'), JSON.stringify({ ignore: ['generated'] }))

    for (const path of ['src/a.ts', 'generated/b.ts']) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), '')
    }

    process.env.XDG_CONFIG_HOME = home

    try {
      expect(await listFiles([], dir)).toEqual(['src/a.ts'])
    }
    finally {
      if (before === undefined)
        delete process.env.XDG_CONFIG_HOME
      else
        process.env.XDG_CONFIG_HOME = before
    }
  })
})
