import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const BARREL = /from '@kaynooo\/utils'/

// The package's index loads every module of utils, which costs about 30 ms and 8 MB at each bin's start; a subpath (`@kaynooo/utils/text`) loads only its own.
test('no package imports the @kaynooo/utils barrel', () => {
  const offenders = readdirSync(`${ROOT}packages`).flatMap(dir =>
    readdirSync(`${ROOT}packages/${dir}/src`, { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.ts'))
      .map(file => `packages/${dir}/src/${file}`)
      .filter(path => BARREL.test(readFileSync(`${ROOT}${path}`, 'utf8'))))

  expect(offenders).toEqual([])
})
