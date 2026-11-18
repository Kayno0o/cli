import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { targetOf } from '../src/browser'

const temp = tempDirs()

async function mockup(): Promise<string> {
  const path = join(temp('page-target-'), 'modern.html')

  await Bun.write(path, '<!doctype html>')

  return path
}

describe('targetOf', () => {
  test('a file:// URL loads that file, its fragment kept, its shots next to it', async () => {
    const path = await mockup()
    const given = `${pathToFileURL(path).href}#apps`

    expect(targetOf(given, undefined)).toEqual({ label: given, url: `${pathToFileURL(path).href}#apps`, stem: path.replace('.html', '') })
  })

  test('a path with a fragment loads the file at that fragment', async () => {
    const path = await mockup()

    expect(targetOf(`${path}#apps`, undefined)).toEqual({ label: `${path}#apps`, url: `${pathToFileURL(path).href}#apps`, stem: path.replace('.html', '') })
  })
})
