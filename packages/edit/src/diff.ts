export interface Diff {
  unified: string
  added: number
  removed: number
}

interface EditOp {
  type: 'equal' | 'insert' | 'delete'
  line: string
  oldLine: number
  newLine: number
}

function splitLines(text: string): string[] {
  if (text === '')
    return []

  const raw = text.split('\n')

  if (text.endsWith('\n'))
    raw.pop()

  return raw
}

// Myers O((N+M)D) shortest edit script for line arrays (zero subprocesses, zero temp files).
function myersDiff(a: readonly string[], b: readonly string[]): EditOp[] {
  const n = a.length
  const m = b.length

  if (n === 0 && m === 0)
    return []

  // Trim shared prefix and suffix so huge files with small edits stay O(1).
  let prefix = 0

  while (prefix < n && prefix < m && a[prefix] === b[prefix])
    prefix++

  let suffix = 0

  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix])
    suffix++

  const midA = a.slice(prefix, n - suffix)
  const midB = b.slice(prefix, m - suffix)
  const ops: EditOp[] = []

  for (let i = 0; i < prefix; i++)
    ops.push({ type: 'equal', line: a[i]!, oldLine: i + 1, newLine: i + 1 })

  const na = midA.length
  const nb = midB.length

  if (na > 0 || nb > 0) {
    const max = na + nb
    const offset = max
    const trace: Int32Array[] = []
    let v = new Int32Array(2 * max + 1)

    v.fill(-1)
    v[offset + 1] = 0

    let foundD = max
    let done = false

    for (let d = 0; d <= max && !done; d++) {
      trace.push(v.slice())

      const next = new Int32Array(2 * max + 1)

      next.fill(-1)

      for (let k = -d; k <= d; k += 2) {
        const down = k === -d || (k !== d && (v[offset + k - 1] ?? -1) < (v[offset + k + 1] ?? -1))
        let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1
        let y = x - k

        while (x < na && y < nb && midA[x] === midB[y]) {
          x++
          y++
        }

        next[offset + k] = x

        if (x >= na && y >= nb) {
          foundD = d
          trace.push(next)
          done = true

          break
        }
      }

      v = next
    }

    // Backtrack shortest edit script.
    const midOps: EditOp[] = []
    let x = na
    let y = nb

    for (let d = foundD; d > 0; d--) {
      const prev = trace[d]!
      const k = x - y
      const down = k === -d || (k !== d && (prev[offset + k - 1] ?? -1) < (prev[offset + k + 1] ?? -1))
      const prevK = down ? k + 1 : k - 1
      const prevX = prev[offset + prevK] ?? 0
      const prevY = prevX - prevK

      while (x > prevX && y > prevY) {
        x--
        y--
        midOps.push({ type: 'equal', line: midA[x]!, oldLine: prefix + x + 1, newLine: prefix + y + 1 })
      }

      if (down) {
        y--
        midOps.push({ type: 'insert', line: midB[y]!, oldLine: prefix + x + 1, newLine: prefix + y + 1 })
      }
      else {
        x--
        midOps.push({ type: 'delete', line: midA[x]!, oldLine: prefix + x + 1, newLine: prefix + y + 1 })
      }
    }

    while (x > 0 && y > 0) {
      x--
      y--
      midOps.push({ type: 'equal', line: midA[x]!, oldLine: prefix + x + 1, newLine: prefix + y + 1 })
    }

    midOps.reverse()
    ops.push(...midOps)
  }

  for (let i = 0; i < suffix; i++) {
    const ai = n - suffix + i
    const bi = m - suffix + i

    ops.push({ type: 'equal', line: a[ai]!, oldLine: ai + 1, newLine: bi + 1 })
  }

  return ops
}

const CONTEXT = 3

// Formats Myers edit ops into standard unified diff hunks (3 lines of context).
export function diffTexts(path: string, before: string, after: string): Diff {
  if (before === after)
    return { unified: '', added: 0, removed: 0 }

  const a = splitLines(before)
  const b = splitLines(after)
  const ops = myersDiff(a, b)
  const added = ops.filter(op => op.type === 'insert').length
  const removed = ops.filter(op => op.type === 'delete').length

  const changeIndices = ops.flatMap((op, i) => op.type === 'equal' ? [] : [i])

  if (changeIndices.length === 0)
    return { unified: '', added: 0, removed: 0 }

  // Group change indices into hunks separated by at most 2 * CONTEXT equal lines.
  const ranges: [start: number, end: number][] = []

  for (const idx of changeIndices) {
    const start = Math.max(0, idx - CONTEXT)
    const end = Math.min(ops.length - 1, idx + CONTEXT)
    const prev = ranges.at(-1)

    if (prev !== undefined && start <= prev[1] + 1)
      prev[1] = Math.max(prev[1], end)
    else
      ranges.push([start, end])
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]

  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1)
    const oldLines = slice.filter(op => op.type !== 'insert')
    const newLines = slice.filter(op => op.type !== 'delete')
    const oldStart = oldLines.length === 0 ? Math.max(0, (slice[0]?.oldLine ?? 1) - 1) : oldLines[0]!.oldLine
    const newStart = newLines.length === 0 ? Math.max(0, (slice[0]?.newLine ?? 1) - 1) : newLines[0]!.newLine

    out.push(`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`)

    for (const op of slice) {
      if (op.type === 'equal')
        out.push(` ${op.line}`)
      else if (op.type === 'delete')
        out.push(`-${op.line}`)
      else
        out.push(`+${op.line}`)
    }
  }

  return { unified: `${out.join('\n')}\n`, added, removed }
}
