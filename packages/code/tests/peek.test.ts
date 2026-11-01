import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { definitions, outline } from '../src/source'

const CLI = new URL('../src/peek.ts', import.meta.url).pathname

const SOURCE = `import { x } from './x'

// Adds one, as the tests want.
export function addOne(value: number): number {
  const text = '}'

  return value + 1
}

export const LIMIT = 5

export type Pair = {
  from: string
  to: string
}

export class Counter {
  private count = 0

  increment(by = 1): void {
    if (by > 0) {
      this.count += addOne(by) - 1
    }
  }

  get value(): number {
    return this.count
  }
}
`

let dir = ''

function peek(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peek-'))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), SOURCE)
  writeFileSync(join(dir, 'src/b.ts'), 'import { addOne } from \'./a\'\n\nconsole.log(addOne(2))\n')
  writeFileSync(join(dir, 'README.md'), '# Title\n\ntext\n\n## Usage\n')
})

describe('definitions', () => {
  test('spans a declaration with its comment, a brace inside a string kept out of the count', () => {
    expect(definitions(SOURCE, 'a.ts', 'addOne')).toEqual([{ path: 'a.ts', from: 3, to: 8 }])
    expect(definitions(SOURCE, 'a.ts', 'LIMIT')).toEqual([{ path: 'a.ts', from: 10, to: 10 }])
    expect(definitions(SOURCE, 'a.ts', 'Pair')).toEqual([{ path: 'a.ts', from: 12, to: 15 }])
    expect(definitions(SOURCE, 'a.ts', 'increment')).toEqual([{ path: 'a.ts', from: 20, to: 24 }])
  })

  test('takes a Python body by its indentation', () => {
    expect(definitions('def a():\n    return 1\n\n    # still a\n\ndef b():\n    pass\n', 'x.py', 'a')).toEqual([{ path: 'x.py', from: 1, to: 4 }])
  })
})

describe('outline', () => {
  test('lists the declarations and the members of a class', () => {
    expect(outline(SOURCE, 'a.ts').map(entry => [entry.line, entry.depth, entry.text])).toEqual([
      [4, 0, 'export function addOne(value: number): number'],
      [10, 0, 'export const LIMIT = 5'],
      [12, 0, 'export type Pair = {'.replace(' {', '')],
      [17, 0, 'export class Counter'],
      [20, 1, 'increment(by = 1): void'],
      [26, 1, 'get value(): number'],
    ])
  })
})

describe('peek', () => {
  test('prints several spans with their line numbers', () => {
    expect(peek('src/a.ts:4-5', 'src/b.ts:3', 'README.md')).toEqual({ code: 0, out: 'src/a.ts:4-5\n4  export function addOne(value: number): number {\n5    const text = \'}\'\n\nsrc/b.ts:3-3\n3  console.log(addOne(2))\n\nREADME.md:1-5\n1  # Title\n2  \n3  text\n4  \n5  ## Usage\n', err: '' })
  })

  test('prints a definition, the usages and an outline', () => {
    expect(peek('--def', 'value').out).toBe('src/a.ts:26-28\n26    get value(): number {\n27      return this.count\n28    }\n')
    expect(peek('--refs', 'addOne').out).toBe('src/a.ts\n 4  export function addOne(value: number): number {\n22  this.count += addOne(by) - 1\n\nsrc/b.ts\n1  import { addOne } from \'./a\'\n3  console.log(addOne(2))\n')
    expect(peek('--outline', 'README.md').out).toBe('README.md\n1  # Title\n5    ## Usage\n')
  })

  test('prints the lines around a pattern, merging close matches', () => {
    expect(peek('--around', 'count', '-C', '1', 'src/a.ts').out).toBe('src/a.ts:17-19\n17  export class Counter {\n18    private count = 0\n19  \n\nsrc/a.ts:21-23\n21      if (by > 0) {\n22        this.count += addOne(by) - 1\n23      }\n\nsrc/a.ts:26-28\n26    get value(): number {\n27      return this.count\n28    }\n')
    expect(peek('--around', 'count', '-C', '2', 'src/a.ts').out).toStartWith('src/a.ts:16-29\n')
  })

  test('exits 1 on nothing found and 2 on a usage error', () => {
    expect(peek('--def', 'nothing').code).toBe(1)
    expect(peek('--def', 'a', '--refs', 'b').code).toBe(2)
    expect(peek('src/a.ts:9-3').code).toBe(2)
    expect(peek('missing.ts').code).toBe(1)
  })

  test('prints JSON in every mode, and its failures as JSON', () => {
    expect(JSON.parse(peek('src/b.ts:3', '--json').out)).toEqual([{ path: 'src/b.ts', from: 3, to: 3, lines: ['console.log(addOne(2))'] }])
    expect(JSON.parse(peek('--def', 'LIMIT', '--json').out)).toEqual([{ path: 'src/a.ts', from: 10, to: 10, lines: ['export const LIMIT = 5'] }])
    expect(JSON.parse(peek('--refs', 'addOne', 'src/b.ts', '--json').out)).toEqual([{ path: 'src/b.ts', line: 1, text: 'import { addOne } from \'./a\'' }, { path: 'src/b.ts', line: 3, text: 'console.log(addOne(2))' }])
    expect(JSON.parse(peek('--outline', 'README.md', '--json').out)).toEqual([{ path: 'README.md', line: 1, depth: 0, text: '# Title' }, { path: 'README.md', line: 5, depth: 1, text: '## Usage' }])
    expect((JSON.parse(peek('--around', 'private', '-C', '0', '--json').out) as unknown[]).length).toBe(1)
    expect(peek('--def', 'nothing', '--json')).toEqual({ code: 1, out: '', err: '{"error":"no declaration of nothing found"}\n' })
  })
})
