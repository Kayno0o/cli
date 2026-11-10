import type { Downloaded } from './download'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
}

// The largest text kept to diff against the next download.
const KEPT_TEXT = 1024 * 1024

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
