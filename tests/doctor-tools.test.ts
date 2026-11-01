import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { TOOLS } from '../packages/doctor/src/checks'

const PACKAGES = new URL('../packages', import.meta.url).pathname

test('doctor checks every package that installs a bin, with its bins', () => {
  const packages = readdirSync(PACKAGES).flatMap((dir) => {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as { name: string, bin?: Record<string, string> }

    return manifest.bin === undefined ? [] : [[manifest.name, Object.keys(manifest.bin)] as const]
  })

  expect(TOOLS).toEqual(Object.fromEntries(packages) as Record<string, string[]>)
})
