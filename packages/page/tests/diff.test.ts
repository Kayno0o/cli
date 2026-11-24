import type { Compared } from '../src/types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()
const PAGE = (heading: string): string => `<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:monospace}h1{margin:100px 0 0 40px;font-size:32px}</style><h1>${heading}</h1><p style="margin:400px 40px">Footer text</p>`

async function page(args: string[]): Promise<{ code: number, out: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return { code, out }
}

describe('page diff', () => {
  test('boxes the region that differs and writes both PNGs into --out', async () => {
    const dir = temp('page-diff-')

    await Bun.write(join(dir, 'mockup.html'), PAGE('Share workspace'))
    await Bun.write(join(dir, 'built.html'), PAGE('Share project'))

    const { code, out } = await page(['diff', join(dir, 'mockup.html'), join(dir, 'built.html'), '-w', '800', '-o', dir, '--json'])
    const [result] = JSON.parse(out) as Compared[]

    expect(code).toBe(1)
    expect(result?.side).toBe(join(dir, 'built-side-800.png'))
    expect(result?.overlay).toBe(join(dir, 'built-diff-800.png'))
    expect(existsSync(result!.side) && existsSync(result!.overlay)).toBe(true)
    expect(result?.regions).toHaveLength(1)

    // The heading's line, around y 100, and nothing near the footer.
    const [region] = result!.regions

    expect(region!.y).toBeGreaterThanOrEqual(80)
    expect(region!.y + region!.height).toBeLessThan(200)
    expect(region!.x).toBeGreaterThanOrEqual(32)
  }, 60_000)

  test('--mask hides dynamic regions so differing timestamps produce zero diff', async () => {
    const dir = temp('page-diff-mask-')
    const tpl = (ts: string) => `<!doctype html><meta charset="utf-8"><title>t</title><style>body{margin:0;font-family:monospace}.ts{display:inline-block;padding:8px}</style><h1>Status</h1><span class="ts">${ts}</span>`

    await Bun.write(join(dir, 'a.html'), tpl('2026-01-01 10:00:00'))
    await Bun.write(join(dir, 'b.html'), tpl('2026-12-31 23:59:59'))

    const { code, out } = await page(['diff', join(dir, 'a.html'), join(dir, 'b.html'), '-w', '640', '-o', dir, '--mask', '.ts', '--json'])
    const [result] = JSON.parse(out) as Compared[]

    expect(code).toBe(0)
    expect(result?.regions).toEqual([])
  }, 60_000)

  test('exits 0 when the pages look the same', async () => {
    const dir = temp('page-diff-')

    await Bun.write(join(dir, 'mockup.html'), PAGE('Same'))
    await Bun.write(join(dir, 'built.html'), PAGE('Same'))

    const { code, out } = await page(['diff', join(dir, 'mockup.html'), join(dir, 'built.html'), '-w', '640'])

    expect(code).toBe(0)
    expect(out).toContain('640px: no region differs')
  }, 60_000)
})
