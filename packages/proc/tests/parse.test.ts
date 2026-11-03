import { describe, expect, test } from 'bun:test'
import { cgroupContainer, cgroupUnit, parseAddress, parseCgroup, parseCmdline, parseDockerPs, parseEnviron, parseLimits, parseNetTable, parseSize, parseStat, parseStatus, socketInode, statusBytes, statusUid, userNameOf } from '../src/parse'

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 20 4 30 10 -1
   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 777 1 0000000000000000 100 0 0 10 0
`

const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5556 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5557 1 0000000000000000 100 0 0 10 0
`

const UDP = `   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  100: 00000000:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000   100        0 9001 2 0000000000000000 0
  101: 0100007F:0035 0100007F:ABCD 01 00000000:00000000 00:00000000 00000000   100        0 9002 2 0000000000000000 0
`

describe('parseAddress', () => {
  test('reads IPv4 in the host byte order', () => {
    expect(parseAddress('0100007F')).toBe('127.0.0.1')
    expect(parseAddress('00000000')).toBe('0.0.0.0')
    expect(parseAddress('0F01A8C0')).toBe('192.168.1.15')
  })

  test('reads IPv6 and compresses the longest run of zeros', () => {
    expect(parseAddress('00000000000000000000000001000000')).toBe('::1')
    expect(parseAddress('00000000000000000000000000000000')).toBe('::')
    expect(parseAddress('B80D0120000000000000000001000000')).toBe('2001:db8::1')
    expect(parseAddress('0000000000000000FFFF00000100007F')).toBe('::ffff:127.0.0.1')
  })
})

describe('parseNetTable', () => {
  test('keeps the TCP sockets in LISTEN with their port, address, uid and inode', () => {
    expect(parseNetTable(TCP, 'tcp', 4)).toEqual([
      { protocol: 'tcp', family: 4, address: '127.0.0.1', port: 8080, uid: 1000, inode: 12345 },
      { protocol: 'tcp', family: 4, address: '0.0.0.0', port: 80, uid: 0, inode: 777 },
    ])
  })

  test('reads tcp6', () => {
    expect(parseNetTable(TCP6, 'tcp', 6).map(({ address, port }) => `${address}:${port}`)).toEqual(['::1:3000', ':::5432', '::ffff:127.0.0.1:80'])
  })

  test('keeps the bound UDP sockets only', () => {
    expect(parseNetTable(UDP, 'udp', 4)).toEqual([{ protocol: 'udp', family: 4, address: '0.0.0.0', port: 5353, uid: 100, inode: 9001 }])
  })

  test('reads an empty table', () => {
    expect(parseNetTable('', 'tcp', 4)).toEqual([])
  })
})

test('socketInode reads socket links only', () => {
  expect(socketInode('socket:[12345]')).toBe(12_345)
  expect(socketInode('pipe:[12345]')).toBeUndefined()
  expect(socketInode('/dev/null')).toBeUndefined()
})

describe('parseStat', () => {
  const line = '4242 (my (odd) app) S 1 4242 4242 34816 4242 4194304 100 0 0 0 5 3 0 0 20 0 7 0 987654 123456789 4321 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0'

  test('counts the fields after the last parenthesis', () => {
    expect(parseStat(line)).toEqual({ comm: 'my (odd) app', state: 'S', ppid: 1, pgrp: 4242, session: 4242, tty: 34_816, threads: 7, startTicks: 987_654 })
  })

  test('refuses a truncated line', () => {
    expect(parseStat('4242 (x) S 1')).toBeUndefined()
    expect(parseStat('')).toBeUndefined()
  })
})

describe('parseStatus', () => {
  const status = parseStatus('Name:\tbun\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t   2048 kB\nVmSwap:\t       0 kB\n')

  test('reads fields, sizes and the real uid', () => {
    expect(status.get('Name')).toBe('bun')
    expect(statusUid(status)).toBe(1000)
    expect(statusBytes(status, 'VmRSS')).toBe(2_097_152)
    expect(statusBytes(status, 'VmHWM')).toBeUndefined()
  })
})

test('parseLimits keeps names with spaces and an empty unit', () => {
  const limits = parseLimits(`Limit                     Soft Limit           Hard Limit           Units
Max cpu time              unlimited            unlimited            seconds
Max processes             62000                62000                processes
Max open files            1024                 524288               files
Max nice priority         0                    0
`)

  expect(limits.find(limit => limit.name === 'Max open files')).toEqual({ name: 'Max open files', soft: '1024', hard: '524288', units: 'files' })
  expect(limits.find(limit => limit.name === 'Max cpu time')?.soft).toBe('unlimited')
  expect(limits.find(limit => limit.name === 'Max nice priority')?.units).toBe('')
  expect(limits).toHaveLength(4)
})

test('parseCmdline and parseEnviron split on NUL', () => {
  expect(parseCmdline('bun\0run\0dev\0')).toEqual(['bun', 'run', 'dev'])
  expect(parseCmdline('')).toEqual([])
  expect(parseCmdline('a\0\0b\0')).toEqual(['a', '', 'b'])
  expect(parseEnviron('A=1\0B=x=y\0C\0')).toEqual([['A', '1'], ['B', 'x=y'], ['C', '']])
})

describe('cgroup', () => {
  const docker = parseCgroup(`0::/system.slice/docker-${'a'.repeat(64)}.scope\n`)
  const user = parseCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-kitty-123.scope\n')

  test('names the innermost unit', () => {
    expect(cgroupUnit(user)).toBe('app-kitty-123.scope')
    expect(cgroupUnit(parseCgroup('0::/user.slice/user@1000.service/app.slice/foo.service/sub\n'))).toBe('foo.service')
    expect(cgroupUnit(parseCgroup('0::/\n'))).toBeUndefined()
  })

  test('finds a container id', () => {
    expect(cgroupContainer(docker)).toBe('a'.repeat(64))
    expect(cgroupContainer(user)).toBeUndefined()
  })
})

test('parseSize reads units, decimals and a bare number as megabytes', () => {
  expect(parseSize('500M')).toBe(500 * 1024 ** 2)
  expect(parseSize('1.5g')).toBe(1.5 * 1024 ** 3)
  expect(parseSize('800kb')).toBe(800 * 1024)
  expect(parseSize('2')).toBe(2 * 1024 ** 2)
  expect(parseSize('lots')).toBeUndefined()
})

test('userNameOf finds a uid in passwd text', () => {
  const passwd = 'root:x:0:0::/root:/bin/bash\nkay:x:1000:1000::/home/kay:/usr/bin/fish\n'

  expect(userNameOf(passwd, 1000)).toBe('kay')
  expect(userNameOf(passwd, 4)).toBeUndefined()
})

test('parseDockerPs reads published ports, ranges and compose labels', () => {
  const containers = parseDockerPs([
    'web-1\t0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp\tshop\tweb',
    'dns\t0.0.0.0:5300-5301->53/udp\t\t',
    'idle\t\t\t',
    '',
  ].join('\n'))

  expect(containers).toEqual([
    { name: 'web-1', project: 'shop', service: 'web', published: [{ host: 8080, protocol: 'tcp' }, { host: 8080, protocol: 'tcp' }] },
    { name: 'dns', project: undefined, service: undefined, published: [{ host: 5300, protocol: 'udp' }, { host: 5301, protocol: 'udp' }] },
    { name: 'idle', project: undefined, service: undefined, published: [] },
  ])
})
