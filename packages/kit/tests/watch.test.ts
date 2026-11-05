import { describe, expect, test } from 'bun:test'
import { Exit, watching, withoutWatch } from '../src'

function terminal() {
  const written: string[] = []

  return { written, stream: { isTTY: true, write: (text: string) => void written.push(text) } as unknown as NodeJS.WriteStream }
}

describe('watching', () => {
  test('clears the screen and runs the step each round, sleeping the interval between', async () => {
    const { written, stream } = terminal()
    const slept: number[] = []
    let runs = 0
    const code = await watching('', async () => ++runs, stream, async ms => void slept.push(ms), 3)

    expect(code).toBe(3)
    expect(written).toHaveLength(3)
    expect(written[0]).toContain('\x1B[2J')
    expect(slept).toEqual([2000, 2000, 2000])
    expect((await watching('500ms', async () => 0, stream, async ms => void slept.push(ms), 1))).toBe(0)
    expect(slept.at(-1)).toBe(500)
  })

  test('is a usage error off a terminal', async () => {
    let refusal: unknown

    try {
      await watching('', async () => 0, { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream, async () => undefined, 1)
    }
    catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(Exit)
  })
})

describe('withoutWatch', () => {
  test('drops the flag and the interval after it, nothing else', () => {
    expect(withoutWatch(['--json', '--watch', '5s', 'x'])).toEqual(['--json', 'x'])
    expect(withoutWatch(['-w', '--json'])).toEqual(['--json'])
    expect(withoutWatch(['--watch=1s', 'a'])).toEqual(['a'])
    expect(withoutWatch(['--watch', 'repo'])).toEqual(['repo'])
  })
})
