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
  test('a file:// URL loads that file, its fragment kept, defaulting shots to cache folder unless -o is set', async () => {
    const path = await mockup()
    const given = `${pathToFileURL(path).href}#apps`
    const cached = targetOf(given, undefined)

    expect(cached.label).toBe(given)
    expect(cached.url).toBe(`${pathToFileURL(path).href}#apps`)
    expect(cached.stem).toContain('kaynooo-page')
    expect(cached.stem).not.toStartWith(path.replace('.html', ''))

    const explicit = targetOf(given, '/tmp/shots')

    expect(explicit.stem).toBe('/tmp/shots/modern')
  })

  test('a path with a fragment loads the file at that fragment', async () => {
    const path = await mockup()
    const out = temp('page-out-')

    expect(targetOf(`${path}#apps`, out)).toEqual({ label: `${path}#apps`, url: `${pathToFileURL(path).href}#apps`, stem: join(out, 'modern') })
  })
})
