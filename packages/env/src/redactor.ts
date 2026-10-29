import type { KnownSecrets } from './mask'
import { findSecrets, maskLine, PEM_BEGIN, PEM_END } from './mask'

export interface Finding {
  file: string
  line: number
  kind: string
}

const DIFF_START = /^(?:diff --git |@@ )/
const NEW_FILE = /^\+\+\+ (?:b\/)?(.+)$/
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)/

// Masks text pushed in chunks of any size: only whole lines are emitted, so a secret split across two chunks is seen whole, and the lines of a private key block are replaced by one marker.
export class Redactor {
  private pending = ''
  private inKey = false
  private hidden = false

  constructor(private readonly known?: KnownSecrets) {}

  push(chunk: string): string {
    this.pending += chunk

    const end = this.pending.lastIndexOf('\n')

    if (end === -1)
      return ''

    const complete = this.pending.slice(0, end + 1)

    this.pending = this.pending.slice(end + 1)

    return complete.split('\n').slice(0, -1).map(line => this.line(line)).filter(line => line !== undefined).map(line => `${line}\n`).join('')
  }

  end(): string {
    const rest = this.pending

    this.pending = ''

    return rest === '' ? '' : this.line(rest) ?? ''
  }

  private line(line: string): string | undefined {
    if (this.inKey) {
      if (PEM_END.test(line)) {
        this.inKey = false

        return line
      }

      if (this.hidden)
        return undefined

      this.hidden = true

      return '*** private key redacted ***'
    }

    if (PEM_BEGIN.test(line)) {
      this.inKey = !PEM_END.test(line)
      this.hidden = false

      return line
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
      inKey = !PEM_END.test(line)

      continue
    }

    if (PEM_BEGIN.test(line)) {
      inKey = !PEM_END.test(line)
      findings.push({ file, line: number, kind: 'private key' })
    }

    for (const match of findSecrets(line, known))
      findings.push({ file, line: number, kind: match.kind })
  }

  return findings
}
