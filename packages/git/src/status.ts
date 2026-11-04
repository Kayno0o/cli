const AHEAD_BEHIND = /\+(\d+) -(\d+)/
const OCTAL = /[0-7]/
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export interface Change {
  path: string
  // The path a rename or copy started from.
  from?: string
  // git's letters for the index and the working tree, `.` where that side is unchanged.
  index: string
  worktree: string
}

export interface Status {
  branch: string
  oid: string
  upstream: string | null
  aheadBehind: { ahead: number, behind: number } | null
  changes: Change[]
  conflicted: string[]
  untracked: string[]
}

// A path as git prints it, unquoted when it holds a quote, a backslash, a control character or, with core.quotePath, a non-ASCII byte written in octal.
export function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"'))
    return path

  const bytes: number[] = []
  const text = [...path.slice(1, -1)]

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    const next = text[i + 1] ?? ''

    if (char !== '\\') {
      bytes.push(...ENCODER.encode(char))
    }
    else if (OCTAL.test(next)) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 4).join(''), 8))
      i += 3
    }
    else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      i++
    }
  }

  return DECODER.decode(new Uint8Array(bytes))
}

// What follows the first `count` space-separated fields of a line.
function after(line: string, count: number): string {
  let index = 0

  for (let field = 0; field < count; field++)
    index = line.indexOf(' ', index) + 1

  return line.slice(index)
}

// What `git status --porcelain=v2 --branch` prints, null when it holds no branch header.
export function parseStatus(text: string): Status | null {
  const status: Status = { branch: '', oid: '', upstream: null, aheadBehind: null, changes: [], conflicted: [], untracked: [] }
  let hasBranch = false

  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      status.oid = line.slice('# branch.oid '.length)
    }
    else if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length)
      hasBranch = true
    }
    else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length)
    }
    else if (line.startsWith('# branch.ab ')) {
      const [, ahead = '0', behind = '0'] = AHEAD_BEHIND.exec(line) ?? []

      status.aheadBehind = { ahead: Number(ahead), behind: Number(behind) }
    }
    else if (line.startsWith('1 ')) {
      status.changes.push({ path: unquote(after(line, 8)), index: line[2] ?? '.', worktree: line[3] ?? '.' })
    }
    else if (line.startsWith('2 ')) {
      const [path = '', from = ''] = after(line, 9).split('\t')

      status.changes.push({ path: unquote(path), from: unquote(from), index: line[2] ?? '.', worktree: line[3] ?? '.' })
    }
    else if (line.startsWith('u ')) {
      status.conflicted.push(unquote(after(line, 10)))
    }
    else if (line.startsWith('? ')) {
      status.untracked.push(unquote(line.slice(2)))
    }
  }

  return hasBranch ? status : null
}

// The branch, its upstream, the counts of changed files and HEAD in one line, from the parsed status and what `git log -1 --format=%h%x00%s` prints.
export function summary(status: Status, head: string): string {
  const { branch, oid, upstream, aheadBehind, changes, conflicted, untracked } = status
  const on = branch === '(detached)' ? `detached at ${oid.slice(0, 7)}` : `branch \`${branch}\``
  let tracking = 'no upstream'

  // git leaves the counts out when the upstream branch is gone or was never fetched
  if (upstream !== null)
    tracking = aheadBehind === null ? `upstream \`${upstream}\` gone or never fetched` : `${aheadBehind.ahead} ahead and ${aheadBehind.behind} behind \`${upstream}\` as of the last fetch`

  const files = [`${changes.length} changed`, untracked.length > 0 ? `${untracked.length} untracked` : '', conflicted.length > 0 ? `${conflicted.length} conflicted` : ''].filter(Boolean).join(', ')
  const [sha, title] = head.trim().split('\0')
  const last = sha === undefined || sha === '' ? '; no commit yet' : `; HEAD ${sha} ${title ?? ''}`.trimEnd()

  return `${on}, ${tracking}; ${files} files${last}`
}
