// Regenerates src/popular.json: the most downloaded npm package names, read as text from the npm-high-impact package (npm's own "high-impact" list, sorted by weekly downloads), never executed.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HIGH_IMPACT_VERSION = '1.13.0'
const COUNT = 500
const TARBALL = `https://registry.npmjs.org/npm-high-impact/-/npm-high-impact-${HIGH_IMPACT_VERSION}.tgz`
const QUOTED_NAME = /^\s*'([^']+)',?$/gm

const response = await fetch(TARBALL)

if (!response.ok)
  throw new Error(`${TARBALL}: ${response.status}`)

const dir = await mkdtemp(join(tmpdir(), 'pkg-popular-'))
const tarball = join(dir, 'high-impact.tgz')

await Bun.write(tarball, response)

const extract = Bun.spawnSync(['tar', 'xzf', tarball, '-C', dir])

if (extract.exitCode !== 0)
  throw new Error(`tar failed: ${extract.stderr.toString()}`)

const source = await Bun.file(join(dir, 'package/lib/top-download.js')).text()
const names = [...source.matchAll(QUOTED_NAME)].map(match => match[1]).slice(0, COUNT)

await Bun.write(new URL('../src/popular.json', import.meta.url), `${JSON.stringify(names, null, 2)}\n`)
console.log(`wrote ${names.length} names from npm-high-impact ${HIGH_IMPACT_VERSION}`)
