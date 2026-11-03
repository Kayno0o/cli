import type { Row } from '@kaynooo/cli-kit/fzf'
import type { Entry, Kind } from './jobs'
import process from 'node:process'
import { paint } from '@kaynooo/cli-kit'
import { fzf, heightFor } from '@kaynooo/cli-kit/fzf'
import { id, signature } from './jobs'

type Tint = 'yellow' | 'blue' | 'magenta' | 'cyan' | 'green' | 'red'

// Each runner in a color of its own, so a name several of them share reads as several lines at a glance.
const TINTS: Record<Kind, Tint> = { just: 'yellow', make: 'blue', package: 'magenta', composer: 'cyan', deno: 'green', task: 'cyan', mise: 'red', poe: 'green', uv: 'green' }

// The runner is shown only once there are several to tell apart.
export function labelled(entries: Entry[]): boolean {
  return new Set(entries.map(entry => entry.tag)).size > 1
}

// The kind, the folder, the name and the id are hidden fields, which the preview and the choice read back. The runner and the key are the only cells searched.
function row(entry: Entry, labels: boolean, signed: boolean): Row {
  const colors = paint(process.stderr)
  const keyed = entry.dir === '.' ? entry.name : `${colors.dim(`${entry.dir}/`)}${entry.name}`

  return {
    hidden: [entry.kind, entry.dir, entry.name, id(entry)],
    cells: [...labels ? [colors[TINTS[entry.kind]](entry.tag)] : [], keyed, ...signed ? [colors.cyan(signature(entry))] : [], colors.dim(entry.doc ?? '')],
  }
}

// Whole height for the full list; a name several entries share gets the list of its candidates only. Undefined on escape.
export function pickJob(entries: Entry[], narrowed = false): Entry | undefined {
  const labels = labelled(entries)
  const signed = entries.some(entry => signature(entry) !== '')
  const picked = fzf(entries.map(entry => row(entry, labels, signed)), {
    prompt: `${[...new Set(entries.map(entry => entry.tag))].join('/')}> `,
    searched: labels ? 2 : 1,
    ...narrowed ? { height: heightFor(entries.length) } : {},
    // The body of the highlighted line, so a one-liner needs no trip to the file.
    preview: `${process.execPath} ${process.argv[1]} --show {1} {2} {3}`,
  })

  return entries.find(candidate => id(candidate) === picked?.hidden[3])
}
