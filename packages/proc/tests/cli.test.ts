import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const BINS = ['pid', 'ports', 'procs'] as const

function listen() {
  return Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })
}

function run(bin: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, new URL(`../src/${bin}-cli.ts`, import.meta.url).pathname, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe.each(BINS)('%s', (bin) => {
  test('prints its version and its usage', () => {
    expect(run(bin, ['--version']).out.trim()).toBe(version)
    expect(run(bin, ['--help']).out).toContain(`${bin} `)
  })
})

describe('pid', () => {
  test('describes the process it runs against, with the environment only on request', () => {
    const plain = run('pid', [String(process.pid)])

    expect(plain.code).toBe(0)
    expect(plain.out).toContain(`pid ${process.pid}`)
    expect(plain.out).not.toContain('PATH=')

    const json = JSON.parse(run('pid', [String(process.pid), '--json']).out) as { pid: number, user: { uid: number }, parents: unknown[], env: unknown }

    expect(json.pid).toBe(process.pid)
    expect(json.user.uid).toBe(process.getuid?.() ?? -1)
    expect(json.parents.length).toBeGreaterThan(0)
    expect(json.env).toBeUndefined()
  })

  test('masks secrets in the environment it shows', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30000)'], { stdout: 'ignore', env: { ...process.env, PROC_TEST_PASSWORD: 'correct-horse-battery', PROC_TEST_URL: 'postgres://u:s3cretpass@db/app', PROC_TEST_PLAIN: 'visible' } })

    try {
      // The child is up once its environment shows in /proc.
      await Bun.sleep(300)

      const result = run('pid', [String(child.pid), '--env', '--json'])
      const env = (JSON.parse(result.out) as { env: { name: string, value: string }[] }).env

      // Only the environment is checked: a parent's command line may quote anything.
      expect(JSON.stringify(env)).not.toContain('correct-horse')
      expect(JSON.stringify(env)).not.toContain('s3cretpass')
      expect(env.find(entry => entry.name === 'PROC_TEST_PLAIN')?.value).toBe('visible')
      expect(env.find(entry => entry.name === 'PROC_TEST_PASSWORD')?.value).toBe('***')
    }
    finally {
      child.kill()
    }
  })

  test('exits 1 on a pid that does not exist and 2 on a non-number', () => {
    const missing = run('pid', ['999999999'])

    expect(missing.code).toBe(1)
    expect(missing.err).toContain('no process with pid 999999999')
    expect(run('pid', ['abc']).code).toBe(2)
    expect(run('pid', []).code).toBe(2)
  })
})

describe('ports', () => {
  test('lists a listener the test opens, and filters to it', () => {
    const server = listen()

    try {
      const rows = JSON.parse(run('ports', ['--json']).out) as { port: number, pid: number | undefined }[]

      expect(rows.find(row => row.port === server.port)?.pid).toBe(process.pid)

      const one = run('ports', [String(server.port)])

      expect(one.code).toBe(0)
      expect(one.out).toContain(String(process.pid))
      expect(one.out.trim().split('\n')).toHaveLength(2)
    }
    finally {
      server.stop(true)
    }
  })

  test('exits 1 when nothing listens on the port', () => {
    const server = listen()
    const { port } = server

    server.stop(true)

    const result = run('ports', [String(port)])

    expect(result.code).toBe(1)
    expect(result.err).toContain(`nothing listens on port ${port}`)
  })

  test('rejects a port that is not a plain decimal number', () => {
    for (const given of ['0x50', '1e3', ' 80', '+80', '0', '65536'])
      expect(run('ports', [given]).code).toBe(2)
  })

  test('refuses to kill ourselves or without a port', () => {
    const server = listen()

    try {
      const own = run('ports', [String(server.port), '--kill', '--yes'])

      expect(own.code).toBe(1)
      expect(own.err).toContain('ancestors')
      expect(run('ports', ['--kill']).code).toBe(2)
      expect(run('ports', ['70000']).code).toBe(2)
    }
    finally {
      server.stop(true)
    }
  })
})

describe('procs', () => {
  test('--json has the groups shape', () => {
    const result = run('procs', ['--json'])
    const data = JSON.parse(result.out) as { groups: { origin: string, count: number, rss: number, oldestSeconds: number, pids: number[] }[], skipped: number }

    expect(result.code).toBe(0)
    expect(Array.isArray(data.groups)).toBe(true)
    expect(typeof data.skipped).toBe('number')

    for (const group of data.groups) {
      expect(group.count).toBe(group.pids.length)
      expect(group.pids).not.toContain(process.pid)
    }
  })

  test('--kill without --yes stops nothing', () => {
    expect(run('procs', ['--kill', '--min-mem', '1']).code).toBe(0)
  })

  test('refuses a bad size', () => {
    expect(run('procs', ['--min-mem', 'lots']).code).toBe(2)
  })
})
