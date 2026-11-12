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

describe('pick fzf options', () => {
  test('--filter prints every match best first and exits 1 with none', () => {
    expect(pick(['--filter', 'b'], 'xxbz\nabc\nq\n')).toMatchObject({ code: 0, out: 'abc\nxxbz\n' })
    expect(pick(['--filter', 'zzz'], 'a\n')).toMatchObject({ code: 1, out: '' })
  })

  test('--select-1 and --exit-0 take a lone match or none without a selector', () => {
    expect(pick(['--select-1', '--query', 'b'], 'a\nb\n')).toMatchObject({ code: 0, out: 'b\n' })
    expect(pick(['--exit-0', '--query', 'zzz'], 'a\n')).toMatchObject({ code: 1, out: '' })
  })

  test('--nth searches the named fields, the whole line is printed', () => {
    expect(pick(['--delimiter', ':', '--nth', '2', '--filter', 'b'], 'b:x\na:b\n')).toMatchObject({ code: 0, out: 'a:b\n' })
    expect(pick(['--nth', '1', '--filter', 'zz'], 'a zz\n')).toMatchObject({ code: 1 })
    expect(pick(['--nth', 'x'], 'a\n')).toMatchObject({ code: 2, err: expect.stringContaining('--nth') })
  })

  test('--read0 and --print0 use NUL between lines', () => {
    expect(pick(['--read0', '--print0', '--multi', '--filter', 'a'], 'a b\0xa\0c\0')).toMatchObject({ code: 0, out: 'a b\0xa\0' })
  })

  test('prints a line that is not UTF-8 as the bytes it came in, two decoding alike kept apart', () => {
    const result = Bun.spawnSync([process.execPath, CLI, '--read0', '--print0', '--filter', 'caf'], { stdin: new Uint8Array([0x63, 0x61, 0x66, 0xE9, 0, 0x62, 0, 0x63, 0x61, 0x66, 0xE8, 0]), stdout: 'pipe', stderr: 'pipe' })

    expect([...result.stdout]).toEqual([0x63, 0x61, 0x66, 0xE9, 0, 0x63, 0x61, 0x66, 0xE8, 0])
  })

  test('--header and --with-nth are accepted', () => {
    expect(pick(['--header', 'Pick one', '--with-nth', '2', '--filter', 'b'], 'a b\n')).toMatchObject({ code: 0, out: 'a b\n' })
  })
})
