import { describe, expect, test } from 'bun:test'
import { previewCommand, previewLines, runPreview } from '../../src/picker/preview'

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

  test('an abort ends a grandchild still holding the output open', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const running = runPreview('sleep 20 & sleep 20', '', controller.signal)

    await Bun.sleep(200)
    controller.abort()
    expect(await running).toEqual([])
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('an aborted preview shows nothing', async () => {
    const controller = new AbortController()
    const running = runPreview('sleep 5', '', controller.signal)

    controller.abort()
    expect(await running).toEqual([])
  })
})
