import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { copyText, distance, exitCodeOf, holdSignals, openUrl, runCommand, stripAnsi } from '../src'
import { tempDirs } from '../src/test'

const temp = tempDirs()

const SRC = JSON.stringify(join(import.meta.dir, '../src'))
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
const ZOMBIE_STATE = /^\d+ \(.*\) Z/

// Whether the process ended within 2 s; in a container with no init reaping orphans, a killed one lingers as a zombie, which counts as ended.
async function isGone(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 20; tries++) {
    try {
      process.kill(pid, 0)
    }
    catch {
      return true
    }

    let stat

    // It may be reaped between the signal and the read, its /proc entry gone with it.
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    }
    catch {
      return true
    }

    if (ZOMBIE_STATE.test(stat))
      return true

    await Bun.sleep(100)
  }

  return false
}

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
    const dir = temp('kit-open-')
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

describe('copyText', () => {
  test('pipes the text into the first clipboard tool found', async () => {
    const dir = temp('kit-copy-')
    const tool = join(dir, 'tool')

    writeFileSync(tool, `#!/bin/sh\ncat > "${join(dir, 'clip')}"\n`)
    chmodSync(tool, 0o755)

    expect(await copyText('hello', command => command === 'xclip' ? tool : null)).toBe(true)
    expect(await written(join(dir, 'clip'))).toBe('hello')
  })

  test('says false with no tool, or when it fails', async () => {
    expect(await copyText('x', () => null)).toBe(false)
    expect(await copyText('x', () => '/bin/false')).toBe(false)
    expect(await copyText('y', command => ({ 'wl-copy': '/bin/false', 'xclip': '/no/such/tool' })[command] ?? null)).toBe(false)
    expect(await copyText('x', () => '/no/such/tool')).toBe(false)
  })
})

describe('runCommand', () => {
  test('returns the output of both streams and the exit code', async () => {
    const ran = await runCommand(['sh', '-c', 'echo out; echo err >&2; exit 3'])

    expect(ran.code).toBe(3)
    expect(ran.text.split('\n').filter(Boolean).toSorted()).toEqual(['err', 'out'])
    expect(ran.chunks.map(chunk => chunk.stream).toSorted()).toEqual(['stderr', 'stdout'])
    expect(ran.stdout).toBe('out\n')
  })

  test('runs in a folder with an environment', async () => {
    expect((await runCommand(['sh', '-c', 'echo $WORD; pwd'], { cwd: '/', env: { WORD: 'hi' } })).text).toBe('hi\n/\n')
  })

  test('throws when the command cannot start', async () => {
    expect(runCommand(['/no/such/command'])).rejects.toThrow()
  })

  test('ends the whole process group on a timeout, grandchildren included', async () => {
    const dir = temp('kit-timeout-')
    const pidFile = join(dir, 'pid')
    const started = Date.now()
    const ran = await runCommand(['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 300 })

    expect(ran.timedOut).toBe(true)
    expect(ran.code).toBeGreaterThan(128)
    expect(Date.now() - started).toBeLessThan(5000)

    const grandchild = Number(readFileSync(pidFile, 'utf8'))

    expect(await isGone(grandchild)).toBe(true)
  })

  test('reports no timeout when the command ends in time', async () => {
    const ran = await runCommand(['sh', '-c', 'echo hi'], { timeoutMs: 5000 })

    expect(ran).toMatchObject({ code: 0, timedOut: false, truncated: false, text: 'hi\n' })
  })

  test('ends the command when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = runCommand(['sleep', '30'], { signal: controller.signal })

    await Bun.sleep(100)
    controller.abort()

    expect((await pending).code).toBe(143)
  })

  test('keeps at most maxBytes while still reading the rest', async () => {
    const ran = await runCommand(['sh', '-c', 'head -c 100000 /dev/zero | tr "\\0" a'], { maxBytes: 1000 })

    expect(ran.code).toBe(0)
    expect(ran.truncated).toBe(true)
    expect(ran.output.length).toBeLessThanOrEqual(1000)
  })

  test('keeps what came first up to maxBytes, the chunk passing it cut and nothing after', async () => {
    const ran = await runCommand(['sh', '-c', 'printf aaaaaa; sleep 0.1; printf bbbbbbbb; sleep 0.1; printf ccc'], { maxBytes: 10 })

    expect(ran.text).toBe('aaaaaabbbb')
    expect((await runCommand(['sh', '-c', 'printf abcdefghijkl'], { maxBytes: 5 })).text).toBe('abcde')
    expect((await runCommand(['sh', '-c', 'printf aaaé'], { maxBytes: 4 })).text).toBe('aaa')
  })

  test('ends the command and rethrows when the collector throws', async () => {
    const seen: number[] = []
    let thrown: unknown

    try {
      await runCommand(['sh', '-c', 'echo a; sleep 30'], { onChunk: () => {
        seen.push(1)

        throw new Error('collector broke')
      } })
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(new Error('collector broke'))
    expect(seen.length).toBe(1)
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
    expect(stripAnsi('\u001B]8;;https://x.test\u001B\\link\u001B]8;;\u001B\\ \u001B]0;title\u0007\u001B[>4;1m.')).toBe('link .')
  })

  test('distance counts edits', () => {
    expect(distance('kitten', 'sitting')).toBe(3)
    expect(distance('same', 'same')).toBe(0)
    expect(distance('raect', 'react')).toBe(1)
    expect(distance('axois', 'axios')).toBe(1)
  })
})
