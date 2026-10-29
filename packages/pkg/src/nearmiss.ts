import popularNames from './popular.json'

const SEPARATORS = /[-_.]/g
const MIN_LENGTH = 5

// Edit distance between two names.
export function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (const [i, left] of [...a].entries()) {
    const current = [i + 1]

    for (const [j, right] of [...b].entries())
      current.push(Math.min((previous[j + 1] ?? 0) + 1, (current[j] ?? 0) + 1, (previous[j] ?? 0) + (left === right ? 0 : 1)))

    previous = current
  }

  return previous[b.length] ?? 0
}

function baseName(name: string): string {
  return name.slice(name.indexOf('/') + 1)
}

function scopeOf(name: string): string {
  return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : ''
}

function squash(name: string): string {
  return name.toLowerCase().replace(SEPARATORS, '')
}

// Why a name resembles a popular one it is not: the same name under another scope, differing only in separators or case, or one or two edits away.
function resemblance(name: string, popular: string): string | undefined {
  if (scopeOf(name) !== scopeOf(popular) && baseName(name) === baseName(popular) && baseName(name).length >= MIN_LENGTH)
    return `${popular} under another scope`

  if (squash(name) === squash(popular))
    return `${popular} spelled with other separators or case`

  const edits = distance(name, popular)
  const allowed = Math.min(name.length, popular.length) >= MIN_LENGTH * 2 ? 2 : 1

  return Math.min(name.length, popular.length) >= MIN_LENGTH && edits <= allowed ? `${popular}, ${edits} ${edits === 1 ? 'edit' : 'edits'} away` : undefined
}

// Up to three popular names this one looks like, closest first; none when the name is itself popular.
export function nearMisses(name: string, popular: readonly string[] = popularNames): string[] {
  if (popular.includes(name))
    return []

  const found: { text: string, edits: number }[] = []

  for (const other of popular) {
    const text = resemblance(name, other)

    if (text !== undefined)
      found.push({ text, edits: distance(name, other) })
  }

  return found.sort((a, b) => a.edits - b.edits).slice(0, 3).map(match => match.text)
}
