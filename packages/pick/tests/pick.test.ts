import { describe, expect, test } from 'bun:test'
import { previewCommand, previewLines, runPreview } from '../src/preview'

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

describe('previewCommand', () => {
  test('quotes the line wherever {} stands', () => {
    expect(previewCommand('cat {} {}', 'a b')).toBe('cat \'a b\' \'a b\'')
    expect(previewCommand('echo {}', 'it\'s $(x)')).toBe('echo \'it\'\\\'\'s $(x)\'')
  })
})

describe('previewLines', () => {
  test('drops escapes, the trailing newline and anything past 200 lines', () => {
    expect(previewLines('\x1B[1mhi\x1B[0m\nthere\n')).toEqual(['hi', 'there'])
    expect(previewLines('x\n'.repeat(500))).toHaveLength(200)
  })
})

describe('runPreview', () => {
  test('runs the command with the quoted line and merges stderr', async () => {
    const lines = await runPreview('printf "%s\\n" {}; echo oops >&2', 'a \'b\' $HOME', new AbortController().signal)

    expect(lines).toEqual(['a \'b\' $HOME', 'oops'])
  })

  test('caps what a command prints', async () => {
    const lines = await runPreview('yes line', '', new AbortController().signal)

    expect(lines).toHaveLength(200)
  })

  test('an aborted preview shows nothing', async () => {
    const controller = new AbortController()
    const running = runPreview('sleep 5', '', controller.signal)

    controller.abort()
    expect(await running).toEqual([])
  })
})
