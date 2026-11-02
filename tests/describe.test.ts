import type { Description } from '../packages/kit/src/args'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { bins, run } from './bins'

// What `agent-tools list` reads off each bin, so a bin that stops describing itself fails here rather than drops off the list.
describe('every bin describes itself', () => {
  for (const { bin, source } of bins) {
    test(bin, () => {
      const described = JSON.parse(run(source, ['--help'], { KIT_HELP: 'json' })) as Description

      expect(described.summary).not.toBe('')
      expect(described.replaces ?? '').not.toBe('')
      expect(described.examples.length).toBeGreaterThanOrEqual(2)
      expect(described.examples.filter(({ line }) => !line.includes(bin))).toEqual([])
    })
  }
})

// Built as the build scripts do, every bin of a package in one call: there an entry importing another entry runs that one's `import.meta.main` block too, which no run from source shows.
describe('every built bin answers as itself', () => {
  const outdir = mkdtempSync(join(tmpdir(), 'built-bins-'))

  afterAll(() => rmSync(outdir, { recursive: true, force: true }))

  const byPackage = Map.groupBy(bins, ({ source }) => dirname(source))

  for (const [dir, packageBins] of byPackage) {
    test(packageBins.map(({ bin }) => bin).join(', '), async () => {
      const built = await Bun.build({ entrypoints: packageBins.map(({ source }) => source), target: 'bun', outdir: join(outdir, basename(dirname(dir))) })

      expect(built.success).toBe(true)

      for (const { bin, source } of packageBins) {
        const output = join(outdir, basename(dirname(dir)), basename(source).replace('.ts', '.js'))
        const described = JSON.parse(run(output, ['--help'], { KIT_HELP: 'json' })) as Description

        expect(`${bin}: ${described.synopsis}`).toStartWith(`${bin}: ${bin}`)
      }
    })
  }
})
