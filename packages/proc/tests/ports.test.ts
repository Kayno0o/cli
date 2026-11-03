import type { Container, Socket } from '../src/parse'
import type { ProcInfo } from '../src/read'
import { describe, expect, test } from 'bun:test'
import { buildRows, refusal } from '../src/ports'

function socket(over: Partial<Socket>): Socket {
  return { protocol: 'tcp', family: 4, address: '127.0.0.1', port: 3000, inode: 1, uid: 1000, ...over }
}

function proc(over: Partial<ProcInfo>): ProcInfo {
  return { pid: 100, ppid: 1, comm: 'bun', args: ['/usr/bin/bun', 'dev.ts', '--token=abc'], uid: 1000, state: 'S', session: 1, rss: 0, startMs: 0, cwd: '/home/kay/app', ...over }
}

const shop: Container = { name: 'shop-web-1', project: 'shop', service: 'web', published: [{ host: 8080, protocol: 'tcp' }] }

describe('buildRows', () => {
  test('merges the IPv4 and IPv6 sockets of one owner and masks the command', () => {
    const rows = buildRows(
      [socket({ inode: 1 }), socket({ inode: 2, family: 6, address: '::1' })],
      new Map([[1, 100], [2, 100]]),
      new Map([[100, proc({})]]),
      [],
    )

    expect(rows).toEqual([{ port: 3000, protocol: 'tcp', addresses: ['127.0.0.1', '::1'], pid: 100, command: 'bun dev.ts --token=***', cwd: '/home/kay/app', uid: 1000, container: undefined }])
  })

  test('keeps TCP and UDP of one port apart and sorts by port', () => {
    const rows = buildRows([socket({ port: 53, protocol: 'udp', inode: 3 }), socket({ port: 53, inode: 4 }), socket({ port: 22, inode: 5 })], new Map(), new Map(), [])

    expect(rows.map(row => `${row.port}/${row.protocol}`)).toEqual(['22/tcp', '53/tcp', '53/udp'])
  })

  test('gives a docker-proxy port, or one with an unreadable owner, its container', () => {
    const proxy = proc({ pid: 200, comm: 'docker-proxy', args: ['/usr/bin/docker-proxy', '-host-port', '8080'], uid: 0 })
    const viaProxy = buildRows([socket({ port: 8080, inode: 7 })], new Map([[7, 200]]), new Map([[200, proxy]]), [shop])
    const unreadable = buildRows([socket({ port: 8080, inode: 7 })], new Map(), new Map(), [shop])

    expect(viaProxy[0]?.container).toEqual({ name: 'shop-web-1', project: 'shop', service: 'web' })
    expect(unreadable[0]?.container?.service).toBe('web')
    expect(unreadable[0]?.pid).toBeUndefined()
  })

  test('a port a normal process holds ignores a container publishing the same number on another protocol', () => {
    const rows = buildRows([socket({ port: 8080, inode: 8 })], new Map([[8, 100]]), new Map([[100, proc({})]]), [shop])

    expect(rows[0]?.container).toBeUndefined()
  })
})

describe('refusal', () => {
  const guard = { uid: 1000, mine: new Set([50]) }
  const rowOf = (over: Partial<ReturnType<typeof buildRows>[number]> = {}) => ({ port: 3000, protocol: 'tcp' as const, addresses: [], pid: 100, command: 'bun', cwd: undefined, uid: 1000, container: undefined, ...over })

  test('lets a process of the user be stopped', () => {
    expect(refusal(rowOf(), proc({}), guard)).toBeUndefined()
  })

  test('names the container to stop for docker-proxy and for an unreadable owner', () => {
    const container = { name: 'shop-web-1', project: 'shop', service: 'web' }

    expect(refusal(rowOf({ container }), proc({ comm: 'docker-proxy' }), guard)).toContain('docker stop shop-web-1')
    expect(refusal(rowOf({ container, pid: undefined }), undefined, guard)).toContain('docker stop shop-web-1')
  })

  test('refuses an unreadable owner, pid 1 and other users', () => {
    expect(refusal(rowOf({ pid: undefined }), undefined, guard)).toContain('not readable')
    expect(refusal(rowOf({ pid: 1 }), proc({ pid: 1 }), guard)).toContain('pid 1')
    expect(refusal(rowOf(), proc({ uid: 0 }), guard)).toContain('another user')
  })
})
