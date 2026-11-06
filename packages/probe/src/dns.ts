import { Resolver } from 'node:dns/promises'

const TIMEOUT_MS = 3000

/** A resolver asked: a name for the report and the `ip[:port]` it is reached at, none for the system's own. */
export interface DnsServer {
  name: string
  address?: string
}

export const PUBLIC_RESOLVERS: DnsServer[] = [
  { name: 'cloudflare', address: '1.1.1.1' },
  { name: 'google', address: '8.8.8.8' },
  { name: 'quad9', address: '9.9.9.9' },
]

export interface DnsAnswer {
  resolver: string
  server: string
  authoritative: boolean
  a: string[]
  aaaa: string[]
  cname: string[]
  // The shortest TTL among the records, in seconds: how long a cache may keep this answer.
  ttl: number | null
  error?: string
}

/** The queries a report needs, so the comparison can be tested without a network. */
export interface DnsClient {
  servers: (server: DnsServer) => string
  records: (server: DnsServer, host: string) => Promise<Omit<DnsAnswer, 'resolver' | 'server' | 'authoritative'>>
  nameservers: (zone: string) => Promise<string[]>
  addressOf: (host: string) => Promise<string | undefined>
}

export interface DnsReport {
  target: string
  zone: string | null
  answers: DnsAnswer[]
  agree: boolean
  warnings: string[]
}

function resolverFor(server: DnsServer, timeoutMs: number): Resolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })

  if (server.address !== undefined)
    resolver.setServers([server.address])

  return resolver
}

function failureOf(error: unknown): string {
  const code = (error as { code?: string }).code

  if (code === 'ETIMEOUT' || code === 'ECONNREFUSED')
    return 'no answer'

  return code === 'ENOTFOUND' || code === 'ENODATA' ? 'no such record' : String((error as Error).message ?? error)
}

// The records of one type, empty when the name has none; any other failure is thrown on.
async function settled<T>(query: Promise<T[]>): Promise<T[]> {
  try {
    return await query
  }
  catch (error) {
    const code = (error as { code?: string }).code

    if (code === 'ENOTFOUND' || code === 'ENODATA')
      return []

    throw error
  }
}

/** The client asking real servers, each query given up after `timeoutMs`. */
export function network(timeoutMs = TIMEOUT_MS): DnsClient {
  const upstream = PUBLIC_RESOLVERS[0]!

  return {
    servers: server => server.address ?? resolverFor(server, timeoutMs).getServers().join(', '),
    async records(server, host) {
      const resolver = resolverFor(server, timeoutMs)

      try {
        const [a, aaaa, cname] = await Promise.all([settled(resolver.resolve4(host, { ttl: true })), settled(resolver.resolve6(host, { ttl: true })), settled(resolver.resolveCname(host))])
        const ttls = [...a, ...aaaa].map(record => record.ttl)

        return { a: a.map(record => record.address).sort(), aaaa: aaaa.map(record => record.address).sort(), cname, ttl: ttls.length === 0 ? null : Math.min(...ttls) }
      }
      catch (error) {
        return { a: [], aaaa: [], cname: [], ttl: null, error: failureOf(error) }
      }
    },
    // An alias is never a zone apex, and a resolver asked for its NS records answers its target's.
    async nameservers(zone) {
      const resolver = resolverFor(upstream, timeoutMs)
      const [nameservers, alias] = await Promise.all([settled(resolver.resolveNs(zone)), settled(resolver.resolveCname(zone))])

      return alias.length > 0 ? [] : nameservers
    },
    async addressOf(host) {
      return (await settled(resolverFor(upstream, timeoutMs).resolve4(host)))[0]
    },
  }
}

// The zone holding the host and its nameservers: the host itself or the nearest parent that has NS records.
async function zoneOf(host: string, client: DnsClient): Promise<{ zone: string, nameservers: string[] } | undefined> {
  const labels = host.split('.')

  for (let at = 0; at < labels.length - 1; at++) {
    const zone = labels.slice(at).join('.')
    const nameservers = await failingToNothing(client.nameservers(zone))

    if (nameservers !== undefined && nameservers.length > 0)
      return { zone, nameservers: nameservers.sort() }
  }

  return undefined
}

// A lookup that times out or is refused counts as finding nothing: the report goes on with the other servers.
async function failingToNothing<T>(query: Promise<T>): Promise<T | undefined> {
  try {
    return await query
  }
  catch {
    return undefined
  }
}

/**
 * Whether two answers say the same: an alias compares by its target alone, since the zone's nameservers do not follow it out of the zone; addresses agree when they share one, so a round robin rotating its records is no disagreement.
 * A CDN answering by location can still show as one.
 */
export function sameAnswer(one: DnsAnswer, other: DnsAnswer): boolean {
  if (one.error !== undefined || other.error !== undefined)
    return one.error === other.error

  if (one.cname.length > 0 || other.cname.length > 0)
    return one.cname.join() === other.cname.join()

  const mine = [...one.a, ...one.aaaa]
  const theirs = new Set([...other.a, ...other.aaaa])

  return mine.length === 0 ? theirs.size === 0 : mine.some(address => theirs.has(address))
}

/** What each resolver answers for the host, then whether they agree, the authoritative nameservers being the reference. */
export async function dnsReport(target: string, host: string, client: DnsClient = network()): Promise<DnsReport> {
  const found = await zoneOf(host, client)
  const authoritative = await Promise.all((found?.nameservers ?? []).map(async (name): Promise<DnsServer | undefined> => {
    const address = await failingToNothing(client.addressOf(name))

    return address === undefined ? undefined : { name, address }
  }))
  const asked = [
    ...[{ name: 'system' }, ...PUBLIC_RESOLVERS].map(server => ({ server, authoritative: false })),
    ...authoritative.filter(server => server !== undefined).map(server => ({ server, authoritative: true })),
  ]
  const answers = await Promise.all(asked.map(async ({ server, authoritative }) => ({ resolver: server.name, server: client.servers(server), authoritative, ...await client.records(server, host) })))

  return { target, zone: found?.zone ?? null, answers, ...verdictOf(answers, found !== undefined) }
}

export function verdictOf(answers: DnsAnswer[], zoneFound: boolean): Pick<DnsReport, 'agree' | 'warnings'> {
  const warnings: string[] = []
  const answered = answers.filter(answer => answer.error !== 'no answer')
  const reference = answered.filter(answer => answer.authoritative)
  const truth = reference[0] ?? answered[0]
  const agree = truth === undefined || answered.every(answer => sameAnswer(answer, truth))

  if (!zoneFound)
    warnings.push('no zone with nameservers was found for this name')

  if (reference.some(answer => !sameAnswer(answer, reference[0]!)))
    warnings.push('the zone\'s own nameservers disagree: one of them has not taken the last change yet')

  for (const answer of answers) {
    if (answer.error === 'no answer')
      warnings.push(`${answer.resolver} did not answer`)
  }

  if (reference.length === 0 || agree)
    return { agree, warnings }

  const stale = answered.filter(answer => !answer.authoritative && !sameAnswer(answer, truth))

  for (const answer of stale) {
    const until = answer.ttl === null ? '' : `, cached for up to ${answer.ttl}s more`

    warnings.push(answer.resolver === 'system'
      ? `the system resolver answers differently from the zone's nameservers${until}: \`sudo resolvectl flush-caches\` drops its copy`
      : `${answer.resolver} answers differently from the zone's nameservers${until}: the change has not reached it yet`)
  }

  return { agree, warnings }
}

/** Whether any resolver knows the name: one of them answers with a record. */
export function known(report: Pick<DnsReport, 'answers'>): boolean {
  return report.answers.some(answer => answer.error === undefined && answer.a.length + answer.aaaa.length + answer.cname.length > 0)
}
