// A DNS server on a local UDP port answering from a table, so the real resolver client is tested without the network.

type DnsRecord = { type: 'A', address: string } | { type: 'AAAA', address: string } | { type: 'CNAME' | 'NS', target: string }

interface Entry {
  records: (DnsRecord & { ttl: number })[]
  // NXDOMAIN rather than an empty answer.
  missing?: boolean
}

const TYPES = { A: 1, NS: 2, CNAME: 5, AAAA: 28 } as const

function encodeName(name: string): number[] {
  return [...name.split('.').filter(Boolean).flatMap(label => [label.length, ...new TextEncoder().encode(label)]), 0]
}

function rdataOf(record: DnsRecord): number[] {
  if (record.type === 'A')
    return record.address.split('.').map(Number)

  if (record.type === 'AAAA') {
    const [head = '', tail = ''] = record.address.split('::')
    const groups = (part: string): number[] => part === '' ? [] : part.split(':').map(group => Number.parseInt(group, 16))
    const words: number[] = [...groups(head), ...Array.from<number>({ length: 8 - groups(head).length - groups(tail).length }).fill(0), ...groups(tail)]

    return words.flatMap(word => [word >> 8, word & 0xFF])
  }

  return encodeName(record.target)
}

function u16(value: number): number[] {
  return [value >> 8, value & 0xFF]
}

function u32(value: number): number[] {
  return [...u16(value >>> 16), ...u16(value & 0xFFFF)]
}

// The question's name and type, and where the question ends.
function questionOf(query: Uint8Array): { name: string, type: number, end: number } {
  const labels: string[] = []
  let at = 12

  while (query[at] !== 0) {
    const length = query[at]!

    labels.push(new TextDecoder().decode(query.subarray(at + 1, at + 1 + length)))
    at += length + 1
  }

  return { name: labels.join('.').toLowerCase(), type: (query[at + 1]! << 8) | query[at + 2]!, end: at + 5 }
}

/** Serves the table until stopped; `silent` takes queries and never answers, as a resolver that is down. */
export async function dnsServer(table: Record<string, Entry>, { silent = false } = {}): Promise<{ address: string, stop: () => void }> {
  const socket = await Bun.udpSocket({
    hostname: '127.0.0.1',
    socket: {
      data(server, data, port, address) {
        if (silent)
          return

        const query = new Uint8Array(data)
        const { name, type, end } = questionOf(query)
        const entry = table[name]
        // A CNAME answers any type, then the records of its target for that type.
        const alias = entry?.records.find(record => record.type === 'CNAME')
        const target = alias === undefined || alias.type !== 'CNAME' ? undefined : table[alias.target.toLowerCase()]
        const own = entry?.records.filter(record => TYPES[record.type] === type || (record.type === 'CNAME' && type !== TYPES.CNAME)) ?? []
        const chased = target?.records.filter(record => TYPES[record.type] === type).map(record => ({ ...record, owner: alias!.type === 'CNAME' ? alias!.target : name })) ?? []
        const answers = [...own.map(record => ({ ...record, owner: undefined as string | undefined })), ...type === TYPES.CNAME ? [] : chased]
        const flags = entry === undefined || entry.missing === true ? 0x8183 : 0x8180
        const body = answers.flatMap(record => [...record.owner === undefined ? [0xC0, 0x0C] : encodeName(record.owner), ...u16(TYPES[record.type]), ...u16(1), ...u32(record.ttl), ...u16(rdataOf(record).length), ...rdataOf(record)])
        const reply = new Uint8Array([...query.subarray(0, 2), ...u16(flags), ...u16(1), ...u16(answers.length), 0, 0, 0, 0, ...query.subarray(12, end), ...body])

        server.send(reply, port, address)
      },
    },
  })

  return { address: `127.0.0.1:${socket.port}`, stop: () => socket.close() }
}
