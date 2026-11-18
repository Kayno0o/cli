import { chmodSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
// Every package shipping a bin, so a new one is covered without being listed.
const CLIS = readdirSync(`${ROOT}packages`).filter(dir => (JSON.parse(readFileSync(`${ROOT}packages/${dir}/package.json`, 'utf8')) as { bin?: unknown }).bin !== undefined)

interface Manifest { version: string, bin: Record<string, string> }

// The published packages run their bundles, with cli-kit inlined, so each bin must start from dist alone, by its path through sh as npm links it (BusyBox env has no -S, #339).
describe('bundles', () => {
  for (const dir of CLIS) {
    test(`${dir} builds bins that run`, async () => {
      const cwd = `${ROOT}packages/${dir}`
      const build = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd, stdout: 'pipe', stderr: 'pipe' })

      expect(build.exitCode).toBe(0)

      const { version, bin } = await Bun.file(`${cwd}/package.json`).json() as Manifest

      for (const file of Object.values(bin)) {
        chmodSync(`${cwd}/${file}`, 0o755)

        const run = Bun.spawnSync([`${cwd}/${file}`, '--version'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

        expect({ out: run.stdout.toString().trim(), err: run.stderr.toString() }).toEqual({ out: version, err: '' })
        expect((await Bun.file(`${cwd}/${file}`).text()).startsWith('#!/bin/sh\n')).toBe(true)
      }
    }, 30_000)
  }
})
