import type { Downloaded } from './download'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLI_FOLDER, stateHome } from '@kaynooo/cli-kit'

// The last download of a URL: what it was, and when.
export interface Seen {
  url: string
  sha256: string
  size: number
  at: string
}

export interface LedgerEntry {
  kind: 'bin' | 'script'
  // The command's name for a bin, the host and path of the URL for a script.
  name: string
  url: string
  sha256: string
  // Where a bin was installed.
  path?: string
  at: string
  // How it was checked, for `dl update` to check the next one the same way: a checksums file, a signature and the key (a file as an absolute path).
  sums?: string
  sig?: string
  key?: string
  // What tells `dl outdated` the source did not change without downloading it again.
  etag?: string
  lastModified?: string
  // The arguments a script ran with.
  args?: string[]
}

/** A download that broke off, kept for the next `dl` of its URL to resume: what the server called it and what tells the file did not change since. */
export interface Part {
  url: string
  name: string
  etag?: string
  lastModified?: string
}

// The largest text kept to diff against the next download.
const KEPT_TEXT = 1024 * 1024
// A part nobody resumed within this long is dropped, as it can be gigabytes.
const PART_LIFETIME = 7 * 24 * 3600_000

export function stateDir(): string {
  return join(stateHome(), CLI_FOLDER, 'dl')
}

function seenDir(url: string): string {
  return join(stateDir(), 'seen', new Bun.CryptoHasher('sha256').update(url).digest('hex').slice(0, 32))
}

// The last download of `url`, and the path of its content when it was text small enough to keep.
export function lastSeen(url: string): { seen: Seen, content: string | undefined } | undefined {
  const dir = seenDir(url)
  const meta = join(dir, 'seen.json')

  if (!existsSync(meta))
    return undefined

  const content = join(dir, 'content')

  return { seen: JSON.parse(readFileSync(meta, 'utf8')) as Seen, content: existsSync(content) ? content : undefined }
}

// Remembers this download of `url` in place of the last one, its content too when it is text small enough.
export function remember(url: string, file: Downloaded): void {
  const dir = seenDir(url)
  const content = join(dir, 'content')

  mkdirSync(dir, { recursive: true })
  rmSync(content, { force: true })

  if (file.text && !file.html && file.size <= KEPT_TEXT)
    copyFileSync(file.path, content)

  writeJson(join(dir, 'seen.json'), { url, sha256: file.sha256, size: file.size, at: new Date().toISOString() } satisfies Seen)
}

/** Where the bytes of a download of `url` go until it is whole, and what was kept of an earlier one that broke off, when there is something to resume. */
export function partOf(url: string): { file: string, kept: (Part & { size: number }) | undefined } {
  const dir = seenDir(url)
  const file = join(dir, 'part')
  const meta = join(dir, 'part.json')

  if (!existsSync(file) || !existsSync(meta))
    return { file, kept: undefined }

  const part = JSON.parse(readFileSync(meta, 'utf8')) as Part
  const size = statSync(file).size

  return { file, kept: part.url === url && size > 0 ? { ...part, size } : undefined }
}

export function keepPart(part: Part): void {
  writeJson(join(seenDir(part.url), 'part.json'), part)
}

export function dropPart(url: string): void {
  rmSync(join(seenDir(url), 'part'), { force: true })
  rmSync(join(seenDir(url), 'part.json'), { force: true })
}

// Drops the parts of every URL left unresumed past their lifetime.
export function dropStaleParts(now = Date.now()): void {
  const seen = join(stateDir(), 'seen')

  if (!existsSync(seen))
    return

  for (const dir of readdirSync(seen)) {
    const file = join(seen, dir, 'part')

    if (existsSync(file) && now - statSync(file).mtimeMs > PART_LIFETIME) {
      rmSync(file, { force: true })
      rmSync(join(seen, dir, 'part.json'), { force: true })
    }
  }
}

function ledgerPath(): string {
  return join(stateDir(), 'ledger.json')
}

export function readLedger(): LedgerEntry[] {
  const path = ledgerPath()

  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as LedgerEntry[] : []
}

// Records a bin installed or a script run, in place of the entry of the same kind and name.
export function record(entry: LedgerEntry): void {
  writeJson(ledgerPath(), [...readLedger().filter(other => other.kind !== entry.kind || other.name !== entry.name), entry])
}

// Written beside, then renamed over, so an interrupted write leaves the last whole file.
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}
