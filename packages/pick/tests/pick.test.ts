import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/pick.ts', import.meta.url).pathname

function pick(args: string[], stdin: string) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('pick', () => {
  test('prints the best line the query matches when stderr is not a terminal, ranked as the selector ranks', () => {
    expect(pick([], 'a\nb\n')).toMatchObject({ code: 0, out: 'a\n' })
    expect(pick(['--query', 'fbr'], 'zzz\nfoobar\n')).toMatchObject({ code: 0, out: 'foobar\n' })
    expect(pick(['--query', 'bar'], 'foo bar baz\nbar\n')).toMatchObject({ code: 0, out: 'bar\n' })
    expect(pick(['--query', 'b', '--multi'], 'xxbz\nabc\nq\n')).toMatchObject({ code: 0, out: 'abc\nxxbz\n' })
    expect(pick(['--query', 'B'], 'abc\nxBz\n')).toMatchObject({ code: 0, out: 'xBz\n' })
    expect(pick(['--query', 'nope'], 'a\n')).toMatchObject({ code: 1, out: '' })
  })

  test('prints the choice as JSON', () => {
    expect(JSON.parse(pick(['--json'], 'a\nb\n').out)).toEqual({ picked: ['a'] })
    expect(JSON.parse(pick(['--json', '--multi', '--query', 'b'], 'ab\nb\nc\n').out)).toEqual({ picked: ['b', 'ab'] })
  })

  test('rejects arguments and a bad height before looking for a terminal', () => {
    expect(pick(['file'], 'a\n')).toMatchObject({ code: 2, err: expect.stringContaining('stdin') })
    expect(pick(['--height', 'tall'], 'a\n')).toMatchObject({ code: 2, err: expect.stringContaining('--height') })
  })
})
