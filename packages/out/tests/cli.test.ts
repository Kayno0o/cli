import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'
import { cleanLogs } from '../src/logs'
import { Recorder } from '../src/run'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const LOG_PATH = /full log: ([^\s\]]+)/

const temp = tempDirs()

const RUNTIME = temp('out-runtime-')
const STATE = temp('out-state-')
const ENV = { ...process.env, XDG_RUNTIME_DIR: RUNTIME, XDG_STATE_HOME: STATE }

function out(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe', env: ENV })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('out --copy', () => {
  test('goes with --last', () => {
    expect(out('--copy')).toMatchObject({ code: 2, err: expect.stringContaining('--copy goes with --last') })
  })
})

describe('out', () => {
  test('prints its version and its help', () => {
    expect(out('--version').out.trim()).toBe(version)
    expect(out('--help').out).toContain('out [-n <lines>] -- <command>')
  })

  test('records each run and --stats reads them back, a --was stage counting against what it would have printed', () => {
    const state = temp('out-stats-cli-')
    const env = { ...ENV, XDG_STATE_HOME: state }
    const spawn = (...args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env })

    spawn('--', 'sh', '-c', 'seq 1 1000')
    spawn('--was', 'tail -n 5', '--', 'seq', '1', '1000')

    const entries = readFileSync(join(state, 'kaynooo-cli/out/stats.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string, bytes: number, baseline: number, shown: number, folded: boolean })
    const stats = JSON.parse(spawn('--stats', '--since', '1d', '--json').stdout.toString()) as { runs: number, commands: { command: string, tokensSaved: number }[] }

    expect(entries.map(each => [each.command, each.bytes, each.folded])).toEqual([['seq', 3893, true], ['seq', 3893, true]])
    expect(entries[1]?.baseline).toBe('996\n997\n998\n999\n1000\n'.length)
    expect(stats.runs).toBe(2)
    expect(stats.commands[0]?.tokensSaved).toBe(Math.round((3893 - (entries[0]?.shown ?? 0) + 21 - (entries[1]?.shown ?? 0)) / 4))
    expect(spawn('--stats').stdout.toString()).toContain('2 runs recorded, 2 folded')
    expect(spawn('--since', '1d', '--', 'true').exitCode).toBe(2)
  })

  test('refuses to run without a command', () => {
    const result = out()

    expect(result.code).toBe(2)
    expect(result.err).toContain('give the command after --')
  })

  test('folds what is piped in, leaving short input untouched, and exits 0', () => {
    const piped = (input: string, ...args: string[]) => {
      const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe', env: ENV })

      return { code: result.exitCode, out: result.stdout.toString() }
    }
    const long = Array.from({ length: 400 }, (_, index) => `compiling file ${index}.ts`).join('\n')

    expect(piped('something\n')).toEqual({ code: 0, out: 'something\n' })
    expect(piped(long, '-n', '50').out).toContain('compiling file 0.ts (x400')
    expect(piped(long, '-n', '50').out).toMatch(LOG_PATH)
  })

  test('passes short output through byte for byte, stdout and stderr apart', () => {
    const result = out('--', 'sh', '-c', 'printf "a\\n  b \\n"; printf "oops\\n" >&2; printf "no newline"')

    expect(result.out).toBe('a\n  b \nno newline')
    expect(result.err).toBe('oops\n')
    expect(result.code).toBe(0)
  })

  test('keeps a character or an escape code split over two writes whole', () => {
    const result = out('--', 'sh', '-c', 'printf "\\342\\202"; sleep 0.2; printf "\\254 \\033[3"; sleep 0.2; printf "1mred\\033[0m\\n"')

    expect(result.out).toBe('€ red\n')
  })

  test('exits with the wrapped command\'s code, short or long', () => {
    expect(out('--', 'sh', '-c', 'echo hi; exit 7').code).toBe(7)
    expect(out('--', 'sh', '-c', 'seq 1 500; exit 3').code).toBe(3)
    expect(out('--', 'sh', '-c', 'kill -TERM $$').code).toBe(143)
    expect(out('--', 'definitely-not-a-command').code).toBe(127)
  })

  test('exits 126 for a command that exists but cannot be run', () => {
    const file = join(temp('out-noexec-'), 'tool.sh')

    writeFileSync(file, '#!/bin/sh\necho hi\n')
    chmodSync(file, 0o644)
    expect(out('--', file).code).toBe(126)
  })

  test('an unwritable log does not stop the command or change its output', () => {
    const recorder = new Recorder(join(temp('out-nolog-'), 'missing', 'dir'))
    const data = new Uint8Array(3 * 1024 * 1024)

    expect(() => {
      recorder.add({ stream: 'stdout', data })
      recorder.add({ stream: 'stdout', data })
      recorder.add({ stream: 'stdout', data })
    }).not.toThrow()
    expect(recorder.bytes).toBe(3 * data.length)
  })

  test('exits with the wrapped command\'s code when the log cannot be written', () => {
    const blocked = join(temp('out-blocked-'), 'file')

    writeFileSync(blocked, '')

    const run = (...command: string[]) => Bun.spawnSync([process.execPath, CLI, '--', ...command], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...ENV, XDG_RUNTIME_DIR: blocked, XDG_STATE_HOME: blocked } })

    expect(run('sh', '-c', 'echo hi; exit 7').exitCode).toBe(7)
    expect(run('sh', '-c', 'seq 1 500; exit 3').exitCode).toBe(3)
  })

  test('folds long output, saving the full log where the header says', () => {
    const result = out('--', 'sh', '-c', 'i=0; while [ $i -lt 400 ]; do echo "row $i of the table is fine"; i=$((i+1)); done; echo "FAILED: boom" >&2')
    const path = LOG_PATH.exec(result.out)?.[1]

    expect(result.out.split('\n').length).toBeLessThan(120)
    expect(result.out).toContain('FAILED: boom')
    expect(path).toBeDefined()
    expect(readFileSync(path ?? '', 'utf8')).toContain('row 399 of the table is fine\nFAILED: boom\n')
  })

  test('keeps the log private to the user', () => {
    const path = LOG_PATH.exec(out('-n', '5', '--', 'seq', '1', '60').out)?.[1] ?? ''

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(path.startsWith(RUNTIME)).toBe(true)
  })

  test('streams output past the memory it keeps to the log, and still folds', () => {
    const result = out('--', 'sh', '-c', 'head -c 6000000 /dev/zero | tr "\\0" a | fold -w 80; echo THE-END')
    const path = LOG_PATH.exec(result.out)?.[1] ?? ''

    expect(result.code).toBe(0)
    expect(result.out).toContain('THE-END')
    expect(result.out).toContain('left out of memory')
    expect(statSync(path).size).toBeGreaterThan(6_000_000)
  })

  test('forwards a signal to the command, exiting with its code', async () => {
    const child = Bun.spawn([process.execPath, CLI, '--', 'sh', '-c', 'sleep 30 & wait'], { stdout: 'pipe', stderr: 'pipe', env: ENV })

    await Bun.sleep(500)
    child.kill('SIGTERM')

    expect(await child.exited).toBe(143)
  })

  test('prints the output untouched when folding it would not make it shorter', () => {
    const runtime = temp('out-unfolded-')
    const result = Bun.spawnSync([process.execPath, CLI, '-n', '5', '--', 'seq', '1', '6'], { stdout: 'pipe', stderr: 'pipe', env: { ...ENV, XDG_RUNTIME_DIR: runtime } })

    expect({ code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }).toEqual({ code: 0, out: '1\n2\n3\n4\n5\n6\n', err: '' })
    expect(readdirSync(runtime, { recursive: true }).filter(name => String(name).endsWith('.log'))).toEqual([])
  })

  test('takes the threshold with -n', () => {
    expect(out('-n', '5', '--', 'seq', '1', '100').out).toContain('full log:')
    expect(out('-n', '6', '--', 'seq', '1', '6').out).toBe('1\n2\n3\n4\n5\n6\n')
    expect(out('-n', 'x', '--', 'seq', '1', '6').code).toBe(2)
  })

  test('takes the default threshold from the lines key of out.json', () => {
    const config = temp('out-config-')
    const env = { ...ENV, XDG_RUNTIME_DIR: temp('out-configured-'), XDG_CONFIG_HOME: config }
    const run = () => Bun.spawnSync([process.execPath, CLI, '--', 'seq', '1', '120'], { stdout: 'pipe', stderr: 'pipe', env }).stdout.toString()

    mkdirSync(join(config, 'kaynooo-cli'))
    expect(run()).not.toContain('full log:')
    writeFileSync(join(config, 'kaynooo-cli', 'out.json'), '{ "lines": 10 }')
    expect(run()).toContain('full log:')
  })
})

describe('out around a step that runs in a compose service', () => {
  test('folds the output of the docker compose exec line check builds, keeping the failure lines and the exit code', () => {
    const bin = temp('out-docker-')
    const script = ['#!/bin/sh', 'shift 2', 'while true; do case "$1" in -T) shift;; -w|-e) shift 2;; *) break;; esac; done', 'shift', 'exec "$@"', ''].join('\n')

    writeFileSync(join(bin, 'docker'), script)
    chmodSync(join(bin, 'docker'), 0o755)

    const inner = 'i=0; while [ $i -lt 400 ]; do echo "row $i of the table is fine"; i=$((i+1)); done; echo "src/a.ts(1,7): error TS2322: bad" >&2; exit 1'
    const line = `cd ${bin} && docker compose exec -T -w /app -e NO_COLOR=1 -e FORCE_COLOR=0 app sh -c '${inner}'`
    const result = Bun.spawnSync([process.execPath, CLI, '--', 'sh', '-c', line], { stdout: 'pipe', stderr: 'pipe', env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } })
    const text = result.stdout.toString()
    const path = LOG_PATH.exec(text)?.[1]

    expect(result.exitCode).toBe(1)
    expect(text.split('\n').length).toBeLessThan(120)
    expect(text).toContain('src/a.ts(1,7): error TS2322: bad')
    expect(readFileSync(path ?? '', 'utf8')).toContain('row 399 of the table is fine')
  })
})

describe('cleanLogs', () => {
  test('removes the logs older than a day and keeps the recent ones', async () => {
    const dir = temp('out-clean-')
    const old = join(dir, 'old.log')
    const recent = join(dir, 'recent.log')
    const now = Date.now()

    writeFileSync(old, 'x')
    writeFileSync(recent, 'x')
    utimesSync(old, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000))
    await cleanLogs(dir, now)

    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  test('ignores a folder that does not exist', async () => {
    await cleanLogs(join(tmpdir(), 'out-missing-folder'))
  })
})

describe('out --stats --json errors', () => {
  test('prints a usage error and a bad --since as the {error} envelope on stderr', () => {
    const extra = out('--stats', '--json', '--', 'ls')
    const since = out('--stats', '--json', '--since', 'soon')

    expect([extra.code, since.code]).toEqual([2, 2])
    expect(extra.out).toBe('')
    expect(JSON.parse(extra.err)).toMatchObject({ error: '--last, --list, --grep and --stats run no command' })
    expect(JSON.parse(since.err)).toMatchObject({ error: expect.stringContaining('--since') })
  })
})

describe('out logs', () => {
  const runtime = temp('out-logs-')
  const logs = join(runtime, 'kaynooo-cli/out')
  const env = { ...ENV, XDG_RUNTIME_DIR: runtime }
  const spawn = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env })

    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }

  test('--last, --list and --grep read the saved logs, the newest by default', () => {
    expect(spawn('--last')).toMatchObject({ code: 2, out: '' })
    expect(spawn('--grep', 'x').code).toBe(2)

    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'old.log'), 'alpha\nerror: old\n')
    writeFileSync(join(logs, 'new.log'), 'alpha\nbeta\nerror: new one\nerror: new two\n')
    utimesSync(join(logs, 'old.log'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

    expect(spawn('--last')).toEqual({ code: 0, out: `${join(logs, 'new.log')}\n`, err: '' })
    expect(spawn('--grep', 'error').out).toBe('3: error: new one\n4: error: new two\n')
    expect(spawn('--grep', 'error', '--log', 'old.log').out).toBe('2: error: old\n')
    expect(spawn('--grep', 'nothing').code).toBe(1)
    expect(spawn('--grep', '(').code).toBe(2)
    expect(spawn('--grep', 'x', '--log', 'missing.log').code).toBe(2)
    expect(spawn('--list').out.split('\n').filter(Boolean).map(line => line.split(/\s+/)[0])).toEqual([join(logs, 'new.log'), join(logs, 'old.log')])
    expect(spawn('--last', '--grep', 'x').code).toBe(2)
    expect(spawn('--log', 'old.log').code).toBe(2)
  })
})
