import type { KnownSecrets } from './mask'
import { findSecrets, KEY_MASK, maskLine, openKeyBody, PEM_END } from './mask'

export interface Finding {
  file: string
  line: number
  kind: string
}

const DIFF_START = /^(?:diff --git |@@ )/
const NEW_FILE = /^\+\+\+ (?:b\/)?(.+)$/
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)/

// A line longer than this with no line break is cut, keeping its last OVERLAP characters to be read with what follows.
const MAX_PENDING = 1 << 18
const OVERLAP = 1 << 13

// Masks text pushed in chunks of any size: only whole lines are emitted, so a secret split across two chunks is seen whole, and the lines of a private key block are replaced by one marker.
export class Redactor {
  private pending = ''
  private inKey = false
  private hidden = false

  constructor(private readonly known?: KnownSecrets) {}

  push(chunk: string): string {
    const end = chunk.lastIndexOf('\n')

    this.pending += chunk

    if (end === -1)
      return this.pending.length > MAX_PENDING ? this.cut() : ''

    const split = this.pending.length - chunk.length + end + 1
    const complete = this.pending.slice(0, split)

    this.pending = this.pending.slice(split)

    return complete.split('\n').slice(0, -1).map(line => this.line(line)).filter(line => line !== undefined).map(line => `${line}\n`).join('')
  }

  // Emits a line that never ends, up to the last space before the overlap when there is one so a secret is not cut in two.
  private cut(): string {
    const limit = this.pending.length - OVERLAP
    const space = this.pending.lastIndexOf(' ', limit)
    const at = space > 0 ? space + 1 : limit
    const head = this.pending.slice(0, at)

    this.pending = this.pending.slice(at)

    return this.line(head) ?? ''
  }

  end(): string {
    const rest = this.pending

    this.pending = ''

    return rest === '' ? '' : this.line(rest) ?? ''
  }

  private line(line: string): string | undefined {
    if (this.inKey) {
      const end = PEM_END.exec(line)

      if (end === null) {
        if (this.hidden)
          return undefined

        this.hidden = true

        return KEY_MASK
      }

      this.inKey = false

      // The text before the END marker is the last of the key, the text after it is read as any line.
      return (end.index > 0 && !this.hidden ? KEY_MASK : '') + this.line(line.slice(end.index))
    }

    const body = openKeyBody(line)

    if (body !== undefined) {
      this.inKey = true
      this.hidden = body !== ''
    }

    return maskLine(line, this.known)
  }
}

// Lists the secrets in text without printing any. A unified diff is read on its added lines, with the new file's name and line numbers.
export function check(text: string, known?: KnownSecrets): Finding[] {
  const findings: Finding[] = []
  const isDiff = text.split('\n').some(line => DIFF_START.test(line))
  let file = 'stdin'
  let number = 0
  let inKey = false

  for (const [index, raw] of text.split('\n').entries()) {
    let line = raw

    if (isDiff) {
      const hunk = HUNK.exec(raw)

      if (hunk !== null) {
        number = Number(hunk[1]) - 1

        continue
      }

      const named = NEW_FILE.exec(raw)

      if (named !== null) {
        file = named[1] ?? file

        continue
      }

      if (raw.startsWith('diff --git ')) {
        file = '(unnamed)'

        continue
      }

      if (raw.startsWith('-') || raw.startsWith('\\'))
        continue

      number++

      if (!raw.startsWith('+'))
        continue

      line = raw.slice(1)
    }
    else {
      number = index + 1
    }

    if (inKey) {
      const end = PEM_END.exec(line)

      inKey = end === null

      if (end === null)
        continue

      line = line.slice(end.index)
    }

    const found = findSecrets(line, known).map(match => match.kind)
    const body = openKeyBody(line)

    if (body !== undefined) {
      inKey = true

      if (body === '')
        found.push('private key')
    }

    for (const kind of found)
      findings.push({ file, line: number, kind })
  }

  return findings
}
