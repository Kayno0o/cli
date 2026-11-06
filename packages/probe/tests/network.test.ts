import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { network } from '../src/dns'
import { dnsServer } from './fixtures/dns-server'

let local: Awaited<ReturnType<typeof dnsServer>>
let silent: Awaited<ReturnType<typeof dnsServer>>

beforeAll(async () => {
  local = await dnsServer({
    'example.test': { records: [{ type: 'NS', target: 'ns1.example.test', ttl: 3600 }] },
    'ns1.example.test': { records: [{ type: 'A', address: '192.0.2.53', ttl: 3600 }] },
    'www.example.test': { records: [{ type: 'A', address: '192.0.2.1', ttl: 60 }, { type: 'AAAA', address: '2001:db8::1', ttl: 120 }] },
    'alias.example.test': { records: [{ type: 'CNAME', target: 'WWW.example.test', ttl: 30 }] },
    'empty.example.test': { records: [] },
    'gone.example.test': { records: [], missing: true },
  })
  silent = await dnsServer({}, { silent: true })
})

afterAll(() => {
  local.stop()
  silent.stop()
})

describe('network', () => {
  const server = () => ({ name: 'local', address: local.address })
  const client = () => network(1000, server())

  test('reads the A and AAAA records with the shortest TTL', async () => {
    expect(await client().records(server(), 'www.example.test')).toEqual({ a: ['192.0.2.1'], aaaa: ['2001:db8::1'], cname: [], ttl: 60 })
  })

  test('an alias gives its target in lowercase along with the records it leads to', async () => {
    expect(await client().records(server(), 'alias.example.test')).toMatchObject({ a: ['192.0.2.1'], cname: ['www.example.test'] })
  })

  test('a name with no records and a name that does not exist both read as no records, not a failure', async () => {
    expect(await client().records(server(), 'empty.example.test')).toEqual({ a: [], aaaa: [], cname: [], ttl: null })
    expect(await client().records(server(), 'gone.example.test')).toEqual({ a: [], aaaa: [], cname: [], ttl: null })
  })

  test('a server that never answers is reported as such', async () => {
    expect(await client().records({ name: 'down', address: silent.address }, 'www.example.test')).toMatchObject({ a: [], error: 'no answer' })
  })

  test('finds a zone\'s nameservers and their address, an alias having none of its own', async () => {
    expect(await client().nameservers('example.test')).toEqual(['ns1.example.test'])
    expect(await client().nameservers('alias.example.test')).toEqual([])
    expect(await client().addressOf('ns1.example.test')).toBe('192.0.2.53')
    expect(await client().addressOf('gone.example.test')).toBeUndefined()
  })

  test('names the server a resolver is reached at', () => {
    expect(client().servers(server())).toBe(local.address)
  })
})
