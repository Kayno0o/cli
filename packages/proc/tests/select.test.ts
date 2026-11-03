import type { ProcInfo } from '../src/read'
import { describe, expect, test } from 'bun:test'
import { HEAVY_DEFAULT, isOrphan, projectOf, selectGroups, toolOf, userDataDir } from '../src/select'

const HOME = '/home/kay'
const NOW = 10_000_000_000
const MB = 1024 ** 2
let next = 1000

function proc(over: Partial<ProcInfo> & { args: string[] }): ProcInfo {
  next++

  return { pid: next, ppid: 1, comm: over.args[0]!.split('/').pop()!.slice(0, 15), uid: 1000, state: 'S', session: next, rss: 10 * MB, startMs: NOW - 3_600_000, cwd: `${HOME}/app`, ...over }
}

const systemd = proc({ pid: 1, args: ['/sbin/init'], comm: 'systemd', uid: 0 })
const userSystemd = proc({ pid: 900, ppid: 1, args: ['systemd', '--user'], comm: 'systemd' })
const shell = proc({ pid: 800, ppid: 900, args: ['fish'], comm: 'fish' })
const markers = new Set([`${HOME}/Work/shop/.git`, `${HOME}/Work/shop/web/package.json`])
const exists = (path: string) => markers.has(path)

function select(procs: ProcInfo[], over: Partial<Parameters<typeof selectGroups>[1]> = {}) {
  return selectGroups([systemd, userSystemd, shell, ...procs], { guard: { uid: 1000, mine: new Set([800]) }, now: NOW, home: HOME, exists, ...over })
}

describe('toolOf', () => {
  test('knows runtimes, the script they run and browsers', () => {
    expect(toolOf({ comm: 'node', args: ['node', '/p/node_modules/.bin/vite', '--port', '3000'], exe: undefined })).toBe('vite')
    expect(toolOf({ comm: 'bun', args: ['bun', 'run', 'src/cli.ts'], exe: undefined })).toBe('bun')
    expect(toolOf({ comm: 'chrome', args: ['/opt/google/chrome/chrome', '--type=renderer'], exe: undefined })).toBe('chromium')
    expect(toolOf({ comm: 'WebKitWebProces', args: ['/usr/lib/webkit2gtk/WebKitWebProcess'], exe: undefined })).toBe('webkit')
    expect(toolOf({ comm: 'rust-analyzer', args: ['rust-analyzer'], exe: undefined })).toBe('rust-analyzer')
    expect(toolOf({ comm: 'vim', args: ['vim'], exe: undefined })).toBeUndefined()
  })
})

test('projectOf prefers the git root and never reaches the home folder', () => {
  expect(projectOf(`${HOME}/Work/shop/web/src`, exists, HOME)).toBe(`${HOME}/Work/shop`)
  expect(projectOf(`${HOME}/Work/other`, exists, HOME)).toBeUndefined()
  expect(projectOf(HOME, exists, HOME)).toBeUndefined()
  expect(projectOf('/', exists, HOME)).toBeUndefined()
  expect(projectOf(undefined, exists, HOME)).toBeUndefined()
})

test('userDataDir reads the profile argument', () => {
  expect(userDataDir(['chrome', '--user-data-dir=/tmp/p1', '--x'])).toBe('/tmp/p1')
  expect(userDataDir(['chrome'])).toBeUndefined()
})

describe('isOrphan', () => {
  const byPid = new Map([systemd, userSystemd, shell].map(item => [item.pid, item]))

  test('reparented to init or to the user systemd', () => {
    expect(isOrphan(proc({ args: ['bun', 'x.ts'], ppid: 1 }), byPid)).toBe(true)
    expect(isOrphan(proc({ args: ['bun', 'x.ts'], ppid: 900 }), byPid)).toBe(true)
    expect(isOrphan(proc({ args: ['bun', 'x.ts'], ppid: 800 }), byPid)).toBe(false)
  })

  test('a systemd service is managed, not left over', () => {
    expect(isOrphan(proc({ args: ['bun', 'x.ts'], ppid: 900, unit: 'api.service' }), byPid)).toBe(false)
  })

  test('a browser is an orphan only as a helper or when a script drives it', () => {
    expect(isOrphan(proc({ args: ['/opt/chrome/chrome'], ppid: 900 }), byPid)).toBe(false)
    expect(isOrphan(proc({ args: ['/opt/chrome/chrome', '--headless=new'], ppid: 900 }), byPid)).toBe(true)
    expect(isOrphan(proc({ args: ['/opt/chrome/chrome', '--type=renderer'], ppid: 1 }), byPid)).toBe(true)
    expect(isOrphan(proc({ args: ['/opt/chrome/chrome_crashpad_handler'], ppid: 1 }), byPid)).toBe(false)
  })
})

describe('selectGroups', () => {
  test('lists orphans and heavy dev processes grouped by project, with totals', () => {
    const orphanA = proc({ args: ['bun', 'dev.ts'], cwd: `${HOME}/Work/shop/web`, rss: 100 * MB, startMs: NOW - 7_200_000 })
    const orphanB = proc({ args: ['node', '/x/node_modules/.bin/vite'], cwd: `${HOME}/Work/shop`, rss: 50 * MB })
    const heavy = proc({ args: ['bun', 'big.ts'], ppid: 800, cwd: '/srv/elsewhere', rss: HEAVY_DEFAULT })
    const light = proc({ args: ['bun', 'small.ts'], ppid: 800, rss: 100 * MB })
    const other = proc({ args: ['vim'], ppid: 1 })
    const { groups } = select([orphanA, orphanB, heavy, light, other])

    expect(groups.map(group => [group.origin, group.members.length]).sort()).toEqual([['bun', 1], ['~/Work/shop', 2]])

    const shop = groups.find(group => group.kind === 'project')!

    expect(shop.rss).toBe(150 * MB)
    expect(shop.oldestMs).toBe(7_200_000)
    expect(shop.orphans).toBe(2)
    expect(groups.find(group => group.kind === 'command')?.members[0]?.heavy).toBe(true)
  })

  test('never selects other users, pid 1, shells, terminals or the ancestors of the caller', () => {
    const theirs = proc({ args: ['bun', 'x'], uid: 0, rss: 2000 * MB })
    const ancestor = proc({ pid: 801, args: ['bun', 'claude'], ppid: 800, rss: 2000 * MB })
    const ancestors = { guard: { uid: 1000, mine: new Set([800, 801]) } }
    const { groups, protectedCount } = select([theirs, ancestor], ancestors)

    expect(groups).toEqual([])
    expect(protectedCount).toBe(1)
  })

  test('--min-mem sets the heavy bar and the floor for orphans, --older the least age', () => {
    const small = proc({ args: ['bun', 'a'], rss: 20 * MB })
    const mid = proc({ args: ['bun', 'b'], rss: 200 * MB, ppid: 800 })
    const young = proc({ args: ['bun', 'c'], rss: 300 * MB, startMs: NOW - 60_000 })

    expect(select([small, mid, young]).groups.flatMap(group => group.members.map(member => member.proc.pid))).toEqual([small.pid, young.pid])
    expect(select([small, mid, young], { minMem: 100 * MB }).groups.flatMap(group => group.members.map(member => member.proc.pid))).toEqual([mid.pid, young.pid])
    expect(select([small, mid, young], { olderMs: 600_000 }).groups.flatMap(group => group.members.map(member => member.proc.pid))).toEqual([small.pid])
  })

  test('a chromium whose main process is gone groups with its helpers by profile', () => {
    const profile = '--user-data-dir=/tmp/pw-profile'
    const renderer = proc({ args: ['/opt/chrome/chrome', '--type=renderer', profile], ppid: 1, cwd: '/' })
    const gpu = proc({ args: ['/opt/chrome/chrome', '--type=gpu-process', profile], ppid: 1, cwd: '/' })
    const zygote = proc({ args: ['/opt/chrome/chrome', '--type=zygote', profile], ppid: renderer.pid, cwd: '/', rss: MB })
    const unrelated = proc({ args: ['/opt/chrome/chrome', '--type=renderer', '--user-data-dir=/tmp/other'], ppid: 800, rss: MB })
    const { groups } = select([renderer, gpu, zygote, unrelated])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe('profile')
    expect(groups[0]?.members.map(member => member.proc.pid).sort()).toEqual([renderer.pid, gpu.pid, zygote.pid].sort())
  })

  test('a heavy process pulls in the dev processes below it', () => {
    const server = proc({ args: ['bun', 'dev.ts'], ppid: 800, rss: 900 * MB, cwd: `${HOME}/Work/shop` })
    const child = proc({ args: ['esbuild', '--service'], comm: 'esbuild', ppid: server.pid, rss: MB, cwd: `${HOME}/Work/shop` })
    const { groups } = select([server, child])

    expect(groups[0]?.members.map(member => member.proc.pid)).toEqual([server.pid, child.pid])
  })
})
