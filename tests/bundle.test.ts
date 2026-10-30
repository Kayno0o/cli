import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const CLIS = ['ft', 'env', 'db', 'check', 'pkg', 'out', 'stack', 'edit']

interface Manifest { version: string, bin: Record<string, string> }

// The published packages run their bundles, with cli-kit inlined, so each bin must start from dist alone.
describe('bundles', () => {
  for (const dir of CLIS) {
    test(`${dir} builds bins that run`, async () => {
      const cwd = `${ROOT}packages/${dir}`
      const build = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd, stdout: 'pipe', stderr: 'pipe' })

      expect(build.exitCode).toBe(0)

      const { version, bin } = await Bun.file(`${cwd}/package.json`).json() as Manifest

      for (const file of Object.values(bin)) {
        const run = Bun.spawnSync([process.execPath, `${cwd}/${file}`, '--version'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

        expect(run.stdout.toString().trim()).toBe(version)
        expect((await Bun.file(`${cwd}/${file}`).text()).startsWith('#!/usr/bin/env bun')).toBe(true)
      }
    }, 30_000)
  }
})
