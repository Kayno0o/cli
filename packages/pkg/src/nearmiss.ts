import { distance } from '@kaynooo/cli-kit'
import popularNames from './popular.json'

const SEPARATORS = /[-_.]/g
const MIN_LENGTH = 5

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

  const shortest = Math.min(name.length, popular.length)
  const allowed = shortest >= MIN_LENGTH * 2 ? 2 : 1

  // names further apart in length than the edits allowed cannot match, which spares the distance computation
  if (shortest < MIN_LENGTH || Math.abs(name.length - popular.length) > allowed)
    return undefined

  const edits = distance(name, popular)

  return edits <= allowed ? `${popular}, ${edits} ${edits === 1 ? 'edit' : 'edits'} away` : undefined
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
