import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { distance, exitCodeOf, holdSignals, openUrl, runCommand, stripAnsi } from '../src'

const SRC = JSON.stringify(join(import.meta.dir, '../src'))
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

// Runs a script importing the kit as `kit`, which sends itself a signal.
async function script(body: string) {
  const child = Bun.spawn([process.execPath, '-e', `import * as kit from ${SRC}\n${body}`], { stdout: 'pipe', stderr: 'pipe' })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return { out, code: child.exitCode, signal: child.signalCode }
}

async function written(path: string): Promise<string> {
  for (let tries = 0; tries < 100 && !(existsSync(path) && readFileSync(path, 'utf8') !== ''); tries++)
    await Bun.sleep(20)

  return readFileSync(path, 'utf8')
}

describe('holdSignals', () => {
  test('runs the cleanup, then ends by the signal as the process would have', async () => {
    expect(await script(`kit.holdSignals(signal => console.log('cleaned', signal))\nprocess.kill(process.pid, 'SIGTERM')\nawait Bun.sleep(5000)`)).toEqual({ out: 'cleaned SIGTERM\n', code: null, signal: 'SIGTERM' })
  })

  test('passes a signal to the child it forwards to, the process going on to exit with the child\'s code', async () => {
    const ran = await script(`const held = kit.holdSignals(() => console.log('cleaned'))\nconst child = Bun.spawn(['sleep', '5'])\nheld.forward(child)\nprocess.kill(process.pid, 'SIGINT')\nawait child.exited\nconsole.log(held.signal, child.signalCode)\nprocess.exit(kit.exitCodeOf(child.exitCode, child.signalCode))`)

    expect(ran).toEqual({ out: 'SIGINT SIGINT\n', code: 130, signal: null })
  })

  test('without a cleanup or a child, only keeps the signal', async () => {
    expect(await script(`const held = kit.holdSignals()\nprocess.kill(process.pid, 'SIGHUP')\nawait Bun.sleep(100)\nconsole.log(held.signal)`)).toEqual({ out: 'SIGHUP\n', code: 0, signal: null })
  })

  test('takes its handlers off once released', () => {
    const before = SIGNALS.map(signal => process.listenerCount(signal))
    const held = holdSignals()

    expect(SIGNALS.map(signal => process.listenerCount(signal))).toEqual(before.map(count => count + 1))
    held.release()
    held.release()
    expect(held.signal).toBeUndefined()
    expect(SIGNALS.map(signal => process.listenerCount(signal))).toEqual(before)
  })
})

describe('openUrl', () => {
  test('hands a URL as given and a path made absolute to the command BROWSER names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-open-'))
    const opener = join(dir, 'opener')

    writeFileSync(opener, `#!/bin/sh\necho "$1" > "$OUT"\n`)
    chmodSync(opener, 0o755)

    expect(openUrl('https://example.test/a?b=1', { BROWSER: opener, OUT: join(dir, 'url') })).toBe(true)
    expect(openUrl('report.html', { BROWSER: opener, OUT: join(dir, 'path') })).toBe(true)
    expect(await written(join(dir, 'url'))).toBe('https://example.test/a?b=1\n')
    expect(await written(join(dir, 'path'))).toBe(`${resolve('report.html')}\n`)
  })

  test('says false when the opener cannot start', () => {
    expect(openUrl('https://example.test', { BROWSER: '/no/such/opener' })).toBe(false)
  })
})

describe('runCommand', () => {
  test('returns the output of both streams and the exit code', async () => {
    const ran = await runCommand(['sh', '-c', 'echo out; echo err >&2; exit 3'])

    expect(ran.code).toBe(3)
    expect(ran.text.split('\n').filter(Boolean).toSorted()).toEqual(['err', 'out'])
    expect(ran.chunks.map(chunk => chunk.stream).toSorted()).toEqual(['stderr', 'stdout'])
  })

  test('runs in a folder with an environment', async () => {
    expect((await runCommand(['sh', '-c', 'echo $WORD; pwd'], { cwd: '/', env: { WORD: 'hi' } })).text).toBe('hi\n/\n')
  })

  test('throws when the command cannot start', async () => {
    expect(runCommand(['/no/such/command'])).rejects.toThrow()
  })
})

describe('exitCodeOf', () => {
  test('a code, else 128 plus the signal', () => {
    expect(exitCodeOf(2, null)).toBe(2)
    expect(exitCodeOf(null, 'SIGTERM')).toBe(143)
    expect(exitCodeOf(null, 9)).toBe(137)
    expect(exitCodeOf(null, null)).toBe(129)
  })
})

describe('text', () => {
  test('stripAnsi removes colour and cursor codes', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m \u001B[2K ok')).toBe('red  ok')
  })

  test('distance counts edits', () => {
    expect(distance('kitten', 'sitting')).toBe(3)
    expect(distance('same', 'same')).toBe(0)
  })
})
