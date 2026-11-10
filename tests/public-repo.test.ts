import { join } from 'node:path'
import { $ } from 'bun'
import { expect, it } from 'bun:test'

// Spelled in parts so this file does not match itself: the private forge domain, the surname, the employer.
const privateWords = [['kevyn', 'fr'].join('.'), ['fyley', 'ssant'].join(''), ['at', 'home'].join('')]
const checkout = join(import.meta.dir, '..')

it('names nothing private: the forge and registry under kaynooo.fr only, no surname, no employer', async () => {
  const grep = await $`git -C ${checkout} grep -lIiF ${privateWords.flatMap(word => ['-e', word])}`.nothrow().quiet()

  // git grep exits 1 when nothing matches; anything above means it could not search at all.
  expect(grep.exitCode).toBeLessThanOrEqual(1)
  expect(grep.text().split('\n').filter(Boolean)).toEqual([])
})
