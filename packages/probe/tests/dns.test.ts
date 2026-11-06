import type { DnsAnswer, DnsClient, DnsServer } from '../src/dns'
import { describe, expect, test } from 'bun:test'
import { dnsReport, known, sameAnswer, verdictOf } from '../src/dns'

type Records = Omit<DnsAnswer, 'resolver' | 'server' | 'authoritative'>

function answer(resolver: string, records: Partial<DnsAnswer> = {}): DnsAnswer {
  return { resolver, server: resolver, authoritative: false, a: [], aaaa: [], cname: [], ttl: 300, ...records }
}

// A client answering from tables: the zones with their nameservers, each nameserver's address, and what each server answers, by name.
function fakeClient(zones: Record<string, string[]>, addresses: Record<string, string>, answers: Record<string, Records>): DnsClient & { asked: string[] } {
  const asked: string[] = []

  return {
    asked,
    servers: (server: DnsServer) => server.address ?? '127.0.0.53',
    async records(server) {
      asked.push(server.name)

      return answers[server.name] ?? { a: [], aaaa: [], cname: [], ttl: null, error: 'no answer' }
    },
    async nameservers(zone) {
      return zones[zone] ?? []
    },
    async addressOf(host) {
      return addresses[host]
    },
  }
}

const NEW: Records = { a: ['203.0.113.2'], aaaa: [], cname: [], ttl: 300 }
const OLD: Records = { a: ['203.0.113.1'], aaaa: [], cname: [], ttl: 120 }

describe('sameAnswer', () => {
  test('addresses agree when they share one, so a rotating round robin is no disagreement', () => {
    expect(sameAnswer(answer('a', { a: ['1.1.1.1', '2.2.2.2'] }), answer('b', { a: ['2.2.2.2', '3.3.3.3'] }))).toBe(true)
    expect(sameAnswer(answer('a', { a: ['1.1.1.1'] }), answer('b', { a: ['2.2.2.2'] }))).toBe(false)
    expect(sameAnswer(answer('a'), answer('b'))).toBe(true)
  })

  test('A and AAAA are compared each on their own, a family one side lacks being a disagreement', () => {
    expect(sameAnswer(answer('a', { a: ['1.1.1.1'], aaaa: ['::1'] }), answer('b', { a: ['2.2.2.2'], aaaa: ['::1'] }))).toBe(false)
    expect(sameAnswer(answer('a', { a: ['1.1.1.1'], aaaa: ['::1'] }), answer('b', { a: ['1.1.1.1'] }))).toBe(false)
  })

  test('alias targets compare without case', () => {
    expect(sameAnswer(answer('a', { cname: ['CDN.test'] }), answer('b', { cname: ['cdn.test'] }))).toBe(true)
  })

  test('an alias compares by its target alone, the zone\'s nameservers not following it', () => {
    expect(sameAnswer(answer('ns', { cname: ['cdn.test'] }), answer('public', { cname: ['cdn.test'], a: ['9.9.9.9'] }))).toBe(true)
    expect(sameAnswer(answer('ns', { cname: ['cdn.test'] }), answer('public', { cname: ['other.test'] }))).toBe(false)
  })

  test('errors agree with the same error only', () => {
    expect(sameAnswer(answer('a', { error: 'no such record' }), answer('b', { error: 'no such record' }))).toBe(true)
    expect(sameAnswer(answer('a', { error: 'no such record' }), answer('b', { a: ['1.1.1.1'] }))).toBe(false)
  })
})

describe('verdictOf', () => {
  const ns = (records: Partial<DnsAnswer>): DnsAnswer => answer('ns1.test', { authoritative: true, ...records })

  test('every resolver giving the zone\'s answer agrees, with no warning', () => {
    expect(verdictOf([answer('system', NEW), answer('google', NEW), ns(NEW)])).toEqual({ agree: true, warnings: [] })
  })

  test('the system resolver alone behind names the cache flush, with how long it may keep its copy', () => {
    const { agree, warnings } = verdictOf([answer('system', OLD), answer('google', NEW), ns(NEW)])

    expect(agree).toBe(false)
    expect(warnings).toEqual(['the system resolver answers differently from the zone\'s nameservers, cached for up to 120s more: `sudo resolvectl flush-caches` drops its copy'])
  })

  test('a public resolver behind and a resolver not answering are each warned about', () => {
    const { warnings } = verdictOf([answer('system', NEW), answer('cloudflare', OLD), answer('quad9', { error: 'no answer' }), ns(NEW)])

    expect(warnings).toEqual([
      'quad9 did not answer',
      'cloudflare answers differently from the zone\'s nameservers, cached for up to 120s more: the change has not reached it yet',
    ])
  })

  test('nameservers disagreeing are warned about, a resolver giving what one of them gives not being behind', () => {
    const { warnings } = verdictOf([answer('system', NEW), answer('cloudflare', OLD), answer('google', { a: ['203.0.113.9'] }), ns(NEW), answer('ns2.test', { authoritative: true, ...OLD })])

    expect(warnings).toEqual([
      'the zone\'s own nameservers disagree: one of them has not taken the last change yet',
      'google answers differently from the zone\'s nameservers, cached for up to 300s more: the change has not reached it yet',
    ])
  })

  test('an alias behind says nothing of how long it stays cached, its TTL not being known', () => {
    expect(verdictOf([answer('system', { cname: ['old.test'], a: ['1.1.1.1'], ttl: 40 }), ns({ cname: ['new.test'] })]).warnings).toEqual(['the system resolver answers differently from the zone\'s nameservers: `sudo resolvectl flush-caches` drops its copy'])
  })

  test('with no nameserver to compare to, resolvers disagreeing are warned about along with why none was asked', () => {
    expect(verdictOf([answer('system', OLD), answer('google', NEW), answer('quad9', OLD)], 'no zone with nameservers was found for this name')).toEqual({ agree: false, warnings: ['no zone with nameservers was found for this name', 'the resolvers disagree, with no nameserver of the zone to tell which is right: google differ from system'] })
  })
})

describe('known', () => {
  test('a name is known once one resolver answers it with a record, an alias included', () => {
    expect(known({ answers: [answer('system', { error: 'no such record' }), answer('google', { cname: ['b.test'] })] })).toBe(true)
    expect(known({ answers: [answer('system', { error: 'no such record' }), answer('google'), answer('quad9', { error: 'no answer' })] })).toBe(false)
  })
})

describe('dnsReport', () => {
  test('asks the system, the public resolvers and each nameserver of the nearest zone, by its address', async () => {
    const client = fakeClient({ 'example.test': ['ns2.example.test', 'ns1.example.test'] }, { 'ns1.example.test': '192.0.2.1', 'ns2.example.test': '192.0.2.2' }, { 'system': OLD, 'cloudflare': NEW, 'google': NEW, 'quad9': NEW, 'ns1.example.test': NEW, 'ns2.example.test': NEW })
    const report = await dnsReport('www.example.test', 'www.example.test', client)

    expect(report.zone).toBe('example.test')
    expect(report.answers.map(({ resolver, server, authoritative }) => [resolver, server, authoritative])).toEqual([
      ['system', '127.0.0.53', false],
      ['cloudflare', '1.1.1.1', false],
      ['google', '8.8.8.8', false],
      ['quad9', '9.9.9.9', false],
      ['ns1.example.test', '192.0.2.1', true],
      ['ns2.example.test', '192.0.2.2', true],
    ])
    expect(report.agree).toBe(false)
    expect(report.warnings).toHaveLength(1)
  })

  test('a nameserver whose address cannot be found is left out, and no zone means no nameserver asked', async () => {
    const client = fakeClient({ 'example.test': ['ns.test', 'lost.test'] }, { 'ns.test': '192.0.2.9' }, { 'system': NEW, 'cloudflare': NEW, 'google': NEW, 'quad9': NEW, 'ns.test': NEW })

    expect((await dnsReport('a.example.test', 'a.example.test', client)).answers.filter(one => one.authoritative).map(one => one.resolver)).toEqual(['ns.test'])

    // A top-level domain is never taken for the zone.
    const none = await dnsReport('a.nowhere', 'a.nowhere', fakeClient({ nowhere: ['ns.nowhere'] }, { 'ns.nowhere': '192.0.2.8' }, { system: NEW }))

    expect(none.zone).toBeNull()
    expect(none.answers.filter(one => one.authoritative)).toEqual([])
    expect(none.warnings).toContain('no zone with nameservers was found for this name')
  })

  test('a trailing dot and capitals are dropped, so a top-level domain still never counts as the zone', async () => {
    const client = fakeClient({ com: ['a.gtld.test'] }, { 'a.gtld.test': '192.0.2.7' }, { system: NEW })
    const report = await dnsReport('X.Nowhere.com.', 'X.Nowhere.com.', client)

    expect(report.zone).toBeNull()
    expect(client.asked).not.toContain('a.gtld.test')
  })

  test('a zone lookup that fails stops the climb, no parent\'s nameservers standing in', async () => {
    const client = fakeClient({ 'example.test': ['ns.example.test'] }, { 'ns.example.test': '192.0.2.1' }, { system: NEW })

    client.nameservers = async zone => ({ 'a.sub.example.test': [], 'example.test': ['ns.example.test'] })[zone] ?? Promise.reject(new Error('timeout'))

    const report = await dnsReport('a.sub.example.test', 'a.sub.example.test', client)

    expect(report.zone).toBeNull()
    expect(report.warnings).toContain('the zone of this name could not be looked up, so no nameserver was asked')
  })
})
