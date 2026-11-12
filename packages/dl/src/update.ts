import type { ExitRow } from '@kaynooo/cli-kit'
import type { LedgerEntry } from './state'
import { Exit, fail, formatAge, jsonOption, parse, printError, printJson, table } from '@kaynooo/cli-kit'
import { get } from './get'
import { readLedger } from './state'

type Freshness = { state: 'current' } | { state: 'changed', now: string } | { state: 'unreachable', error: string }

interface Checked { entry: LedgerEntry, freshness: Freshness }

// How many sources are asked at once.
const AT_ONCE = 4

// Whether the source of an entry moved on: a conditional request answers 304 when the server can tell, else the body is hashed against the sha installed.
async function freshness(entry: LedgerEntry): Promise<Freshness> {
  const headers: Record<string, string> = { 'accept-encoding': 'identity' }

  if (entry.etag !== undefined)
    headers['if-none-match'] = entry.etag
  else if (entry.lastModified !== undefined)
    headers['if-modified-since'] = entry.lastModified

  try {
    const response = await fetch(entry.url, { headers, decompress: false })

    if (response.status === 304)
      return { state: 'current' }

    if (!response.ok) {
      await response.body?.cancel()

      return { state: 'unreachable', error: `answered ${response.status} ${response.statusText}`.trimEnd() }
    }

    const hasher = new Bun.CryptoHasher('sha256')

    for await (const chunk of (response.body ?? new ReadableStream()) as AsyncIterable<Uint8Array>)
      hasher.update(chunk)

    const now = hasher.digest('hex')

    return now === entry.sha256 ? { state: 'current' } : { state: 'changed', now }
  }
  catch (error) {
    return { state: 'unreachable', error: error instanceof Error ? error.message : String(error) }
  }
}

// The ledger entries named, every one without names, each with whether its source moved on.
async function checkAll(names: string[], bins: boolean): Promise<Checked[]> {
  const ledger = readLedger().filter(entry => !bins || entry.kind === 'bin').sort((a, b) => a.name.localeCompare(b.name))
  const unknown = names.filter(name => !ledger.some(entry => entry.name === name))

  if (unknown.length > 0)
    fail(`dl installed or ran nothing named ${unknown.join(', ')}`, 2, 'dl ls lists what it did')

  const entries = names.length === 0 ? ledger : ledger.filter(entry => names.includes(entry.name))
  const checked: Checked[] = []

  for (let at = 0; at < entries.length; at += AT_ONCE)
    checked.push(...await Promise.all(entries.slice(at, at + AT_ONCE).map(async entry => ({ entry, freshness: await freshness(entry) }))))

  return checked
}

function said(freshness: Freshness, was: string): string {
  if (freshness.state === 'changed')
    return `changed, ${was.slice(0, 12)} now ${freshness.now.slice(0, 12)}`

  return freshness.state === 'unreachable' ? `unreachable: ${freshness.error}` : 'current'
}

const OUTDATED_USAGE = `dl outdated [name...] [options]: asks the source of each command dl installed and script it ran whether it changed since

A server that gives an ETag or Last-Modified answers without sending the file again; otherwise the file is downloaded and its sha256 compared.`

const OUTDATED_EXITS: ExitRow[] = [[0, 'every one is current'], [1, 'one changed, or its source cannot be reached'], [2, 'a usage error']]

export async function outdated(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, OUTDATED_USAGE, { bins: { type: 'boolean', description: 'only the commands --bin installed' }, json: jsonOption('[{name, kind, url, at, sha256, state, now?, error?}], state current, changed or unreachable') }, {
    positionals: ['[name...]'],
    exits: OUTDATED_EXITS,
    replaces: 'checking by hand whether a tool installed from a URL has a newer build',
    examples: ['dl outdated', ['dl outdated --bins', 'the installed commands only']],
  })
  const checked = await checkAll(positionals, values.bins === true)
  const behind = checked.filter(({ freshness }) => freshness.state !== 'current')

  if (values.json === true) {
    printJson(checked.map(({ entry, freshness }) => ({ name: entry.name, kind: entry.kind, url: entry.url, at: entry.at, sha256: entry.sha256, ...freshness })))

    return behind.length === 0 ? 0 : 1
  }

  if (behind.length === 0) {
    console.log(checked.length === 0 ? 'nothing installed or run through dl yet' : `all ${checked.length} current`)

    return 0
  }

  const changed = behind.filter(({ freshness }) => freshness.state === 'changed').map(({ entry }) => entry.name)

  console.log(table([['name', 'kind', 'installed', 'source'], ...behind.map(({ entry, freshness }) => [entry.name, entry.kind, formatAge(entry.at), said(freshness, entry.sha256)])], { header: true }))

  if (changed.length > 0)
    console.log(`\nupdate them: dl update ${changed.join(' ')}`)

  return 1
}

const UPDATE_USAGE = `dl update [name...] [options]: downloads again what changed of the commands dl installed and the scripts it ran, checked as it was the first time, then installs or runs it

Without names, every one whose source changed. A checksums file or a signature given at install is checked again; a sha256 given at install cannot pin a new file, so a script it pinned runs only with --yes. A script shows its diff and what it does, and runs with the arguments it had.`

const UPDATE_EXITS: ExitRow[] = [[0, 'every one updated, or nothing changed'], [1, 'one failed to download, check, install or run'], [2, 'a usage error']]

// The dl arguments that fetch an entry again the way it was the first time.
function argvOf(entry: LedgerEntry, yes: boolean): string[] {
  const checks = [...entry.sums === undefined ? [] : ['--sums', entry.sums], ...entry.sig === undefined || entry.key === undefined ? [] : ['--sig', entry.sig, '--key', entry.key]]

  if (entry.kind === 'bin')
    return [entry.url, '--bin', entry.name, '--force', ...checks]

  return [entry.url, '--exec', ...checks, ...yes ? ['--yes'] : [], ...entry.args === undefined ? [] : ['--', ...entry.args]]
}

export async function update(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, UPDATE_USAGE, { yes: { type: 'boolean', description: 'run a changed script that no checksums file or signature pins' } }, {
    positionals: ['[name...]'],
    exits: UPDATE_EXITS,
    examples: [['dl update', 'everything that changed'], ['dl update tool', 'one command']],
  })
  const checked = await checkAll(positionals, false)
  const changed = checked.filter(({ freshness }) => freshness.state === 'changed')
  let code = 0

  for (const { entry, freshness } of checked) {
    if (freshness.state === 'unreachable') {
      printError('dl update', `${entry.name}: ${entry.url} ${freshness.error}`)
      code = 1
    }
  }

  if (changed.length === 0) {
    console.log('nothing changed')

    return code
  }

  for (const { entry } of changed) {
    console.log(`\nupdating ${entry.name}`)

    try {
      code = Math.max(code, await get(argvOf(entry, values.yes === true)))
    }
    catch (error) {
      if (!(error instanceof Exit))
        throw error

      printError('dl update', `${entry.name}: ${error.message}`, error.hint)
      code = 1
    }
  }

  return code
}
