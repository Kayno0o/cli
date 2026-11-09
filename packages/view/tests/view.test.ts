import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/view.ts', import.meta.url).pathname
const temp = tempDirs()

function view(args: string[], stdin?: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, COLUMNS: '', NO_COLOR: '1', ...env } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('view', () => {
  test('shows a markdown file', () => {
    const dir = temp('view-')

    writeFileSync(join(dir, 'a.md'), '# Title\n\nsome **text**\n')

    expect(view([join(dir, 'a.md')])).toMatchObject({ code: 0, out: '# Title\n\nsome text\n' })
  })

  test('takes the text on stdin and recognises a diff, --markdown forcing the other reading', () => {
    expect(view([], '@@ -1 +1 @@\n-a\n+b\n').out).toBe('@@ -1 +1 @@\n-a\n+b\n')
    expect(view(['--markdown'], '# T\n').out).toBe('# T\n')
    expect(view(['--diff'], '# T\n').out).toBe('# T\n')
  })

  test('describes what it showed as JSON', () => {
    expect(JSON.parse(view(['--json'], '# T\n\nsome **text**\n').out)).toEqual({ kind: 'markdown', language: null, text: '# T\n\nsome text\n' })
    expect(JSON.parse(view(['--json'], '@@ -1 +1 @@\n-a\n+b\n').out)).toMatchObject({ kind: 'diff', language: null })
    expect(JSON.parse(view(['--json', '--lang', 'json'], '{"a":1}\n').out)).toMatchObject({ kind: 'code', language: 'json' })
  })

  test('wraps to --width', () => {
    expect(view(['--width', '20'], 'one two three four five six seven\n').out).toBe('one two three four\nfive six seven\n')
  })

  test('wraps to COLUMNS off a terminal', () => {
    expect(view([], 'one two three four five six seven\n', { COLUMNS: '20' }).out).toBe('one two three four\nfive six seven\n')
  })

  test('drops an OSC 8 hyperlink rather than printing it as text', () => {
    expect(view(['--markdown'], 'see \u001B]8;;https://x.test\u001B\\the link\u001B]8;;\u001B\\ here\n').out).toBe('see the link here\n')
  })

  test('exits 1 on nothing to show, 2 on a missing file or a usage error', () => {
    expect(view(['/nonexistent.md']).code).toBe(2)
    expect(view([], '  \n').code).toBe(1)
    expect(view(['--diff', '--markdown'], 'x').code).toBe(2)
    expect(view(['a', 'b']).code).toBe(2)
  })
})

describe('view code', () => {
  test('shows a source file by its extension, numbered only on request outside a terminal', () => {
    const dir = temp('view-')

    writeFileSync(join(dir, 'a.json'), '{"a": 1}\n')

    expect(view([join(dir, 'a.json')]).out).toBe('{"a": 1}\n')
    expect(view([join(dir, 'a.json'), '--lines']).out).toBe('1 │ {"a": 1}\n')
  })

  test('takes --lang for stdin and refuses an unknown language', () => {
    expect(view(['--lang', 'ts'], '# not a heading\n').out).toBe('# not a heading\n')
    expect(view(['--lang', 'nope'], 'x').code).toBe(2)
  })
})
