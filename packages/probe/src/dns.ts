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

  // A name or record that does not exist is no failure: `settled` reads it as no records.
  return code === 'ETIMEOUT' || code === 'ECONNREFUSED' ? 'no answer' : String((error as Error).message ?? error)
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

/** The client asking real servers, each query given up after `timeoutMs` (whole seconds under Bun, at least one); `upstream` finds the zone's nameservers and their addresses. */
export function network(timeoutMs = TIMEOUT_MS, upstream: DnsServer = PUBLIC_RESOLVERS[0]!): DnsClient {
  return {
    servers: server => server.address ?? resolverFor(server, timeoutMs).getServers().join(', '),
    async records(server, host) {
      const resolver = resolverFor(server, timeoutMs)

      try {
        const [a, aaaa, cname] = await Promise.all([settled(resolver.resolve4(host, { ttl: true })), settled(resolver.resolve6(host, { ttl: true })), settled(resolver.resolveCname(host))])
        const ttls = [...a, ...aaaa].map(record => record.ttl)

        return { a: a.map(record => record.address).sort(), aaaa: aaaa.map(record => record.address).sort(), cname: cname.map(target => target.toLowerCase()), ttl: ttls.length === 0 ? null : Math.min(...ttls) }
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

const NO_ZONE = 'no zone with nameservers was found for this name'
const ZONE_LOOKUP_FAILED = 'the zone of this name could not be looked up, so no nameserver was asked'

// The zone holding the host and its nameservers: the host itself or the nearest parent that has NS records, a top-level domain never counting.
// A lookup that fails stops the climb, a parent's nameservers being no reference for a zone delegated below it.
async function zoneOf(host: string, client: DnsClient): Promise<{ zone: string, nameservers: string[] } | { problem: string }> {
  const labels = host.split('.')

  for (let at = 0; at < labels.length - 1; at++) {
    const zone = labels.slice(at).join('.')
    const nameservers = await failingToNothing(client.nameservers(zone))

    if (nameservers === undefined)
      return { problem: ZONE_LOOKUP_FAILED }

    if (nameservers.length > 0)
      return { zone, nameservers: nameservers.sort() }
  }

  return { problem: NO_ZONE }
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

// One family's addresses agree when they share one, so a round robin rotating its records is no disagreement; a family one side has and the other lacks is one.
function sameFamily(mine: string[], theirs: string[]): boolean {
  if (mine.length === 0 || theirs.length === 0)
    return mine.length === theirs.length

  const other = new Set(theirs)

  return mine.some(address => other.has(address))
}

/**
 * Whether two answers say the same: an alias compares by its target alone, since the zone's nameservers do not follow it out of the zone; A and AAAA records each agree when they share an address.
 * A CDN answering by location can still show as a disagreement.
 */
export function sameAnswer(one: DnsAnswer, other: DnsAnswer): boolean {
  if (one.error !== undefined || other.error !== undefined)
    return one.error === other.error

  if (one.cname.length > 0 || other.cname.length > 0)
    return one.cname.join().toLowerCase() === other.cname.join().toLowerCase()

  return sameFamily(one.a, other.a) && sameFamily(one.aaaa, other.aaaa)
}

const TRAILING_DOT = /\.$/

/** What each resolver answers for the host, then whether they agree, the authoritative nameservers being the reference. */
export async function dnsReport(target: string, host: string, client: DnsClient = network()): Promise<DnsReport> {
  const name = host.replace(TRAILING_DOT, '').toLowerCase()
  const found = await zoneOf(name, client)
  const authoritative = await Promise.all(('nameservers' in found ? found.nameservers : []).map(async (nameserver): Promise<DnsServer | undefined> => {
    const address = await failingToNothing(client.addressOf(nameserver))

    return address === undefined ? undefined : { name: nameserver, address }
  }))
  const asked = [
    ...[{ name: 'system' }, ...PUBLIC_RESOLVERS].map(server => ({ server, authoritative: false })),
    ...authoritative.filter(server => server !== undefined).map(server => ({ server, authoritative: true })),
  ]
  const answers = await Promise.all(asked.map(async ({ server, authoritative }) => ({ resolver: server.name, server: client.servers(server), authoritative, ...await client.records(server, name) })))

  return { target, zone: 'zone' in found ? found.zone : null, answers, ...verdictOf(answers, 'problem' in found ? found.problem : undefined) }
}

/** Whether the answers agree and what warrants a warning; `zoneProblem` says why no nameserver could be asked, if none was. */
export function verdictOf(answers: DnsAnswer[], zoneProblem?: string): Pick<DnsReport, 'agree' | 'warnings'> {
  const warnings: string[] = zoneProblem === undefined ? [] : [zoneProblem]
  const answered = answers.filter(answer => answer.error !== 'no answer')
  const reference = answered.filter(answer => answer.authoritative)
  const truth = reference[0] ?? answered[0]
  const agree = truth === undefined || answered.every(answer => sameAnswer(answer, truth))

  if (reference.some(answer => !sameAnswer(answer, reference[0]!)))
    warnings.push('the zone\'s own nameservers disagree: one of them has not taken the last change yet')

  for (const answer of answers) {
    if (answer.error === 'no answer')
      warnings.push(`${answer.resolver} did not answer`)
  }

  if (agree)
    return { agree, warnings }

  if (reference.length === 0) {
    warnings.push(`the resolvers disagree, with no nameserver of the zone to tell which is right: ${answered.filter(answer => !sameAnswer(answer, truth)).map(answer => answer.resolver).join(', ')} differ from ${truth.resolver}`)

    return { agree, warnings }
  }

  // A resolver giving what any of the zone's nameservers gives is not behind, when they disagree among themselves.
  const stale = answered.filter(answer => !answer.authoritative && !reference.some(ns => sameAnswer(answer, ns)))

  for (const answer of stale) {
    // An alias is kept for its own TTL, which the records it leads to do not tell.
    const until = answer.ttl === null || answer.cname.length > 0 ? '' : `, cached for up to ${answer.ttl}s more`

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
