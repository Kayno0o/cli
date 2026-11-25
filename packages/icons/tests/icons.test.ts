import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/icons.ts', import.meta.url).pathname
const projects: string[] = []

afterAll(() => {
  for (const project of projects)
    rmSync(project, { recursive: true, force: true })
})

function project(sets: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-icons-'))

  projects.push(root)
  mkdirSync(join(root, 'src'))

  for (const [prefix, names] of Object.entries(sets)) {
    const folder = join(root, 'node_modules/@iconify-json', prefix)

    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'icons.json'), JSON.stringify({ prefix, icons: Object.fromEntries(names.map(name => [name, { body: '' }])) }))
  }

  return root
}

function icons(cwd: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('icons', () => {
  test('prints the icons of every installed set a related word names, set by set', () => {
    const root = project({ tabler: ['trash', 'home'], lucide: ['trash-2'], mdi: ['trash-can'] })

    expect(icons(root, ['garbage'])).toMatchObject({ code: 0, out: 'lucide:trash-2\nmdi:trash-can\ntabler:trash\n' })
  })

  test('finds the sets of the nearest node_modules from a subfolder', () => {
    const root = project({ tabler: ['home'] })

    expect(icons(join(root, 'src'), ['home']).out).toBe('tabler:home\n')
  })

  test('searches only the set --set names', () => {
    const root = project({ tabler: ['home'], lucide: ['home'] })

    expect(icons(root, ['--set', 'tabler', 'home']).out).toBe('tabler:home\n')
  })

  test('prints at most --limit icons per set', () => {
    const root = project({ tabler: ['home', 'home-2', 'home-3'], lucide: ['home', 'home-2'] })

    expect(icons(root, ['--limit', '1', 'home']).out).toBe('lucide:home\ntabler:home\n')
  })

  test('prints the found icons as JSON', () => {
    const root = project({ tabler: ['home'] })

    expect(JSON.parse(icons(root, ['--json', 'home']).out)).toEqual([{ set: 'tabler', name: 'home' }])
  })

  test('exits 1 when no icon set is installed', () => {
    const { code, err } = icons(project({}), ['home'])

    expect(code).toBe(1)
    expect(err).toContain('no icon set installed in this project')
  })

  test('exits 1 when the --set is not installed', () => {
    const { code, err } = icons(project({ tabler: ['home'] }), ['--set', 'lucide', 'home'])

    expect(code).toBe(1)
    expect(err).toContain('the set lucide is not installed in this project')
  })
})
