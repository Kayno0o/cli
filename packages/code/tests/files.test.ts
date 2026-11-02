import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
