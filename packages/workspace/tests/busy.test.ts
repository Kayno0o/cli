import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { processPlaces, userOf } from '../src/busy'

const temp = tempDirs()

describe('userOf', () => {
  const processes = [{ path: '/w/app/src', who: 'pid 1 node' }]
  const containers = [{ path: '/w/api/var', who: 'container api' }, { path: '/w', who: 'container all' }]

  test('names a process inside the folder, never one in a folder beside it or above it', () => {
    expect(userOf('/w/app', processes, [])).toBe('pid 1 node')
    expect(userOf('/w/ap', processes, [])).toBeUndefined()
    expect(userOf('/w/app/src/deep', processes, [])).toBeUndefined()
  })

  test('names a container mounting a part of the folder or a folder holding it', () => {
    expect(userOf('/w/api', [], containers)).toBe('container api')
    expect(userOf('/w/other', [], containers)).toBe('container all')
    expect(userOf('/x', [], containers)).toBeUndefined()
  })
})

describe('processPlaces', () => {
  test('lists a running bun by its working folder, and leaves out its own run', async () => {
    const dir = join(temp('busy-'), 'app')

    mkdirSync(dir)
    const sleeper = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30000)'], { cwd: dir, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })

    try {
      const places = await processPlaces()

      expect(userOf(dir, places, [])).toBe(`pid ${sleeper.pid} bun`)
      expect(places.some(place => place.who.startsWith(`pid ${process.pid} `))).toBe(false)
    }
    finally {
      sleeper.kill()
    }
  })
})
