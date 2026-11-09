import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { complexityOf, isCandidate } from '../src/churn'

const temp = tempDirs()

const CLI = new URL('../src/hotspots-cli.ts', import.meta.url).pathname
const BRANCHY = 'export function f(a: number) {\n  if (a > 1 && a < 5) {\n    for (const x of [a]) {\n      if (x) return 1\n    }\n  }\n  return a ? 2 : 3\n}\n'
const PLAIN = 'export const a = 1\n'

let dir = ''

function write(path: string, text: string) {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}

// One commit at the date rewriting each path, its first line carrying the date so every commit changes the file.
function commit(date: string, ...paths: string[]) {
  for (const path of paths)
    write(path, `// ${date}\n${path.includes('branchy') ? BRANCHY : PLAIN}`)

  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }

  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir, env })
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', date], { cwd: dir, env })
}

function hotspots(args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

beforeEach(() => {
  dir = temp('hotspots-')
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  write('.gitignore', 'ignored/\n')
  write('ignored/hidden.ts', BRANCHY)
  // branchy.ts: 3 commits and plain.ts: 5 in the window, old.ts one long before it, tests and generated files touched once.
  commit('2020-01-01T00:00:00Z', 'src/old.ts')
  commit('2026-10-01T00:00:00Z', 'src/branchy.ts', 'src/plain.ts', 'tests/branchy.test.ts', 'dist/branchy.js', 'src/api.d.ts')
  commit('2026-10-02T00:00:00Z', 'src/branchy.ts', 'src/plain.ts')
  commit('2026-10-03T00:00:00Z', 'src/branchy.ts', 'src/plain.ts')
  commit('2026-10-04T00:00:00Z', 'src/plain.ts')
  commit('2026-10-05T00:00:00Z', 'src/plain.ts')
})

describe('complexityOf', () => {
  test('counts decision points outside comments and strings', () => {
    expect(complexityOf(BRANCHY)).toBe(6)
    expect(complexityOf(PLAIN)).toBe(1)
    expect(complexityOf('// if (a && b) for\nconst s = "if while &&"\n')).toBe(1)
  })

  test('counts a ternary and not an optional parameter or property', () => {
    expect(complexityOf('function f(a?, b?) { return a }\n')).toBe(1)
    expect(complexityOf('function f(a?: number) { return a?.b }\n')).toBe(1)
    expect(complexityOf('const x = a ? 1 : 2\n')).toBe(2)
  })

  test('blanks a string before a comment, so a url in a string eats nothing', () => {
    expect(complexityOf('const u = "http://x"; if (a) {}\n')).toBe(2)
    expect(complexityOf('// don\'t\nif (a) { b = \'x\' }\n')).toBe(2)
  })

  test('leaves tests and generated paths out', () => {
    expect(['src/a.ts', 'lib/b.py', 'src/c.kay', 'app/d.vue', 'src/E.php'].map(isCandidate)).toEqual([true, true, true, true, true])
    expect(['tests/a.ts', 'src/a.test.ts', 'dist/a.js', 'src/a.d.ts', 'README.md', 'bun.lock'].map(isCandidate)).toEqual([false, false, false, false, false, false])
  })
})

describe('hotspots', () => {
  test('ranks by complexity times churn over the window, tests, generated and ignored files left out', () => {
    const rows = JSON.parse(hotspots(['--json', '--since', '2026-01-01', '--half-life', '0']).out) as { rank: number, path: string, score: number, churn: number, complexity: number, lines: number }[]

    expect(rows.map(row => [row.rank, row.path, row.churn, row.complexity, row.score])).toEqual([[1, 'src/branchy.ts', 3, 6, 18], [2, 'src/plain.ts', 5, 1, 5]])
    expect(rows[0]?.lines).toBe(9)
  })

  test('counts recent commits for more with a half-life, and leaves a bulk commit out', () => {
    const decayed = JSON.parse(hotspots(['--json', '--since', '2026-01-01', '--half-life', '1d']).out) as { path: string, churn: number, recent: number }[]
    const branchy = decayed.find(row => row.path === 'src/branchy.ts')

    expect(branchy?.churn).toBe(3)
    expect(branchy?.recent).toBeLessThan(1)

    const sweep = JSON.parse(hotspots(['--json', '--since', '2026-01-01', '--half-life', '0', '--bulk', '1']).out) as { path: string, churn: number }[]

    expect(sweep.map(row => [row.path, row.churn])).toEqual([['src/plain.ts', 2]])
    expect(hotspots(['--bulk', 'x']).code).toBe(2)
  })

  test('counts the files of a commit over the whole repository, not only under the current folder', () => {
    commit('2026-10-06T00:00:00Z', 'src/plain.ts', 'other/a.ts', 'other/b.ts', 'other/c.ts')

    const result = Bun.spawnSync([process.execPath, CLI, '--json', '--since', '2026-01-01', '--half-life', '0', '--bulk', '3'], { cwd: join(dir, 'src'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
    const rows = JSON.parse(result.stdout.toString()) as { path: string, churn: number }[]

    expect(rows.find(row => row.path === 'plain.ts')?.churn).toBe(4)
  })

  test('shows the lines changed and the authors, and --by-lines scores the lines', () => {
    write('src/plain.ts', `// other\n${PLAIN}more\nmore\n`)
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
    Bun.spawnSync(['git', '-c', 'user.name=u', '-c', 'user.email=u@u', 'commit', '-q', '-m', 'other'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-07T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-07T00:00:00Z' } })

    const args = ['--json', '--since', '2026-01-01', '--half-life', '0']
    const rows = JSON.parse(hotspots(args).out) as { path: string, changed: number, authors: number, solo: boolean, score: number, complexity: number }[]
    const plain = rows.find(row => row.path === 'src/plain.ts')
    const branchy = rows.find(row => row.path === 'src/branchy.ts')

    expect(plain).toMatchObject({ authors: 2, solo: false })
    expect(plain?.changed).toBeGreaterThan(5)
    expect(branchy).toMatchObject({ authors: 1, solo: true })

    const byLines = JSON.parse(hotspots([...args, '--by-lines']).out) as { path: string, score: number, changed: number }[]

    expect(byLines.find(row => row.path === 'src/branchy.ts')?.score).toBe((branchy?.changed ?? 0) * (branchy?.complexity ?? 0))
    expect(hotspots(['--since', '2026-01-01']).out).toContain('1 solo')
  })

  test('names the most complex declaration of a file', () => {
    const rows = JSON.parse(hotspots(['--json', '--since', '2026-01-01']).out) as { path: string, worst?: { name: string, line: number, complexity: number } }[]

    expect(rows.find(row => row.path === 'src/branchy.ts')?.worst).toEqual({ name: 'export function f(a: number) {', line: 2, complexity: 6 })
    expect(hotspots(['--since', '2026-01-01']).out).toContain('export function f(a: number) { (6, line 2)')
  })

  test('widens with an older --since, and keeps everything with --all', () => {
    expect(JSON.parse(hotspots(['--json', '--since', '2000-01-01']).out)).toHaveLength(3)
    expect((JSON.parse(hotspots(['--json', '--since', '2026-01-01', '--all']).out) as { path: string }[]).map(row => row.path)).toContain('tests/branchy.test.ts')
  })

  test('prints a table, limits with --limit and takes a folder', () => {
    const { code, out } = hotspots(['--since', '2026-01-01', '--limit', '1'])

    expect(code).toBe(0)
    expect(out.trim().split('\n')).toHaveLength(3)
    expect(out).toContain('src/branchy.ts')
    expect(out).toContain('more, rerun with --full')
    expect(hotspots(['src', '--json', '--since', '2026-01-01']).out).toContain('src/plain.ts')
  })

  test('takes -n as --limit', () => {
    expect(hotspots(['--since', '2026-01-01', '-n', '1']).out).toContain('more, rerun with --full')
  })

  test('exits 1 with no commit in the window and 2 on a bad count', () => {
    expect(hotspots(['--since', '2030-01-01']).code).toBe(1)
    expect(hotspots(['--limit', 'x']).code).toBe(2)
  })
})
