import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { progressLine, progressText, takesControlCodes } from '../src/progress'

const CLEAR_LINE = '\r\x1B[2K'

function terminal(columns = 80) {
  const written: string[] = []

  return { written, stream: { isTTY: true, columns, write: (text: string) => written.push(text) } }
}

describe('takesControlCodes', () => {
  it('holds for a terminal alone, never a pipe, NO_COLOR, NODE_DISABLE_COLORS or a dumb TERM', () => {
    expect(takesControlCodes({ isTTY: true }, {})).toBe(true)
    expect(takesControlCodes({ isTTY: false }, {})).toBe(false)
    expect(takesControlCodes({}, {})).toBe(false)
    expect(takesControlCodes({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(takesControlCodes({ isTTY: true }, { NODE_DISABLE_COLORS: '1' })).toBe(false)
    expect(takesControlCodes({ isTTY: true }, { TERM: 'dumb' })).toBe(false)
  })
})

describe('the progress line', () => {
  it('is drawn on a terminal alone, never in a log, under NO_COLOR or on a dumb terminal', () => {
    const { stream } = terminal()

    expect(progressLine({ ...stream, isTTY: false }, {})).toBeUndefined()
    expect(progressLine(stream, { NO_COLOR: '1' })).toBeUndefined()
    expect(progressLine(stream, { NODE_DISABLE_COLORS: '1' })).toBeUndefined()
    expect(progressLine(stream, { TERM: 'dumb' })).toBeUndefined()
  })

  it('shows a bar and a count where the total is known, and the time alone where it is not', () => {
    expect(progressText({ step: 'prerendering', done: 5, total: 10, unit: 'routes' }, '⠋', 1520)).toBe('⠋ prerendering ██████████░░░░░░░░░░ 5/10 routes 1.5s')
    expect(progressText({ step: 'encoding images', done: 12, total: 10 }, '⠙', 0)).toBe('⠙ encoding images ████████████████████ 10/10 0.0s')
    expect(progressText({ step: 'bundling' }, '⠹', 240)).toBe('⠹ bundling 0.2s')
    expect(progressText({ step: 'bundling', done: 0, total: 0 }, '⠹', 240)).toBe('⠹ bundling 0.2s')
  })

  it('redraws one line in place, cut to the terminal\'s width', () => {
    const { written, stream } = terminal(20)
    const line = progressLine(stream, {})!

    try {
      line.update({ step: 'prerendering', done: 1, total: 4, unit: 'routes' })
      line.update({ step: 'compressing the files' })
    }
    finally {
      line.stop()
    }

    const frames = written.filter(text => text !== CLEAR_LINE)

    expect(frames).toHaveLength(2)

    for (const frame of frames) {
      expect(frame.startsWith(CLEAR_LINE)).toBe(true)
      // eslint-disable-next-line no-control-regex
      expect(frame.slice(CLEAR_LINE.length).replaceAll(/\x1B\[\d+m/g, '')).toHaveLength(19)
    }

    expect(written.at(-1)).toBe(CLEAR_LINE)
  })

  it('draws a new step at once, its clock started again, and a count moving on with the next frame', async () => {
    const { written, stream } = terminal()
    const line = progressLine(stream, {})!

    try {
      line.update({ step: 'bundling' })
      // The clock has to pass 0.1 s for a new step still on the old one's clock to read other than 0.0s.
      await Bun.sleep(150)

      const drawn = written.length

      line.update({ step: 'prerendering', done: 0, total: 50, unit: 'routes' })

      for (let done = 1; done <= 50; done++)
        line.update({ step: 'prerendering', done, total: 50, unit: 'routes' })

      expect(written.slice(drawn)).toHaveLength(1)
      expect(written.at(-1)).toEndWith(' 0/50 routes 0.0s')

      // The count shows with the next frame of the spinner's timer.
      for (const limit = Date.now() + 5000; !written.at(-1)!.includes(' 50/50 routes ') && Date.now() < limit;)
        await Bun.sleep(10)

      expect(written.at(-1)).toContain(' 50/50 routes ')
    }
    finally {
      line.stop()
    }
  })

  it('takes a terminal that says it is 0 columns wide, as a pseudo-terminal may, for 80', () => {
    const { written, stream } = terminal(0)
    const line = progressLine(stream, {})!
    const step = 'a step named at length '.repeat(5)

    line.update({ step })
    line.stop()

    // eslint-disable-next-line no-control-regex
    expect(written[0]!.slice(CLEAR_LINE.length).replaceAll(/\x1B\[\d+m/g, '')).toBe(`⠋ ${step}`.slice(0, 79))
  })

  it('clears itself before anything else is printed, and gives the console and the streams back once stopped', () => {
    const { written, stream } = terminal()
    const printed: string[] = []
    const log: unknown = Reflect.get(console, 'log')
    const stdoutWrite: unknown = Reflect.get(process.stdout, 'write')
    const stub = (text: string) => {
      printed.push(`${written.length}:${text}`)
    }

    console.log = stub

    try {
      const line = progressLine(stream, {})!

      line.update({ step: 'bundling' })
      console.log('built')

      const drawnAt = written.length

      line.update({ step: 'compressing' })
      process.stdout.write('')

      const clearedAt = written.length

      line.stop()

      expect(written[drawnAt - 1]).toBe(CLEAR_LINE)
      expect(written[clearedAt - 1]).toBe(CLEAR_LINE)
      expect(printed).toEqual([`${drawnAt}:built`])
      expect(Reflect.get(console, 'log') as unknown).toBe(stub)
      expect(Reflect.get(process.stdout, 'write') as unknown).toBe(stdoutWrite)
    }
    finally {
      Reflect.set(console, 'log', log)
    }
  })

  it('leaves what the caller put in the console meanwhile, and its listeners once stopped', () => {
    const { stream } = terminal()
    const warn: unknown = Reflect.get(console, 'warn')
    const listeners = ['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))
    const line = progressLine(stream, {})!
    const replaced = () => undefined

    console.warn = replaced
    line.stop()

    try {
      expect(Reflect.get(console, 'warn') as unknown).toBe(replaced)
      expect(['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(listeners)
    }
    finally {
      Reflect.set(console, 'warn', warn)
    }
  })

  it('is cleared when the task is interrupted, which still ends as interrupted', async () => {
    const script = `import { writeSync } from 'node:fs'\nimport { progressLine } from ${JSON.stringify(join(import.meta.dir, '../src/progress'))}\n\nconst line = progressLine({ isTTY: true, columns: 80, write: text => writeSync(1, \`\${JSON.stringify(text)}\\n\`) }, {})\n\nline.update({ step: 'bundling' })\nprocess.kill(process.pid, 'SIGINT')\nawait Bun.sleep(5000)\n`
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])

    expect(child.signalCode).toBe('SIGINT')
    expect(stdout.trim().split('\n').map(text => JSON.parse(text) as string).at(-1)).toBe(CLEAR_LINE)
  })
})
