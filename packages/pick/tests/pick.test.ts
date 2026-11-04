import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/pick.ts', import.meta.url).pathname

function pick(args: string[], stdin: string) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('pick', () => {
  test('exits 2 with a clear message when stderr is not a terminal', () => {
    expect(pick([], 'a\nb\n')).toMatchObject({ code: 2, out: '', err: expect.stringContaining('not a terminal') })
  })

  test('rejects arguments and a bad height before looking for a terminal', () => {
    expect(pick(['file'], 'a\n')).toMatchObject({ code: 2, err: expect.stringContaining('stdin') })
    expect(pick(['--height', 'tall'], 'a\n')).toMatchObject({ code: 2, err: expect.stringContaining('--height') })
  })
})
