import type { Name } from './code'
import type { Theme } from './theme'
import { escapeControls, stripAnsi } from '@kaynooo/cli-kit'
import { highlight, languageOf } from './code'

const TRAILING_NEWLINE = /\n$/
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(.*)$/
const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/
const NEW_FILE = /^\+\+\+ (?:b\/)?([^\t]*)/
const COMMIT = /^(commit )([0-9a-f]{7,40})(.*)$/
const HUNK_LINE = new Set([' ', '+', '-', '\\'])
const MARKERS = /^(?:--- |\+\+\+ )/
// The colours git writes into a diff; any other escape sequence belongs to the content and is shown.
// eslint-disable-next-line no-control-regex -- escape sequences are what it matches
const GIT_COLOR = /\x1B\[[\d;]*m/g
const META = /^(?:index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch)/
const COMMIT_META = /^(?:Author|Date|Merge|AuthorDate|Commit|CommitDate):/
const TOKEN = /\w+|\s+|[^\w\s]/g
const WORD_CHAR = /\w/
// eslint-disable-next-line no-control-regex -- an escape sequence is what it splits
const ESCAPE = /\x1B\[([0-9;]*)m/g
// The SGR codes ending a style, for the pair of a colour or an emphasis.
const CLOSING = new Set(['0', '22', '23', '24', '27', '29', '39', '49'])
// A pair of lines longer than this in tokens is left as it is, the comparison being quadratic.
const MAX_TOKENS = 300

interface Content {
  mark: '+' | '-'
  text: string
  language: Name | undefined
}

// Whether the text is a diff, a `git log -p` or a `git show`, by its first line.
export function looksLikeDiff(text: string): boolean {
  const first = stripAnsi(text).split('\n').find(line => line.trim() !== '') ?? ''

  return first.startsWith('diff --git ') || first.startsWith('--- ') || first.startsWith('@@ ') || first.startsWith('Index: ') || COMMIT.test(first)
}

// Which characters of each text are not in the longest common run of tokens of the two, undefined when they share no word and so are not a edit of one another.
function changedChars(a: string, b: string): [boolean[], boolean[]] | undefined {
  const left = a.match(TOKEN) ?? []
  const right = b.match(TOKEN) ?? []

  if (left.length > MAX_TOKENS || right.length > MAX_TOKENS)
    return undefined

  const common = Array.from({ length: left.length + 1 }, () => Array.from<number>({ length: right.length + 1 }).fill(0))

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--)
      common[i]![j] = left[i] === right[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
  }

  const flags = (tokens: string[]): boolean[] => tokens.flatMap(token => Array.from<boolean>({ length: token.length }).fill(true))
  const changedLeft = flags(left)
  const changedRight = flags(right)
  let shared = false
  let i = 0
  let j = 0
  let at = 0
  let to = 0

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      shared ||= WORD_CHAR.test(left[i]!)
      changedLeft.fill(false, at, at + left[i]!.length)
      changedRight.fill(false, to, to + right[j]!.length)
      at += left[i]!.length
      to += right[j]!.length
      i++
      j++
    }
    else if (common[i + 1]![j]! >= common[i]![j + 1]!) {
      at += left[i++]!.length
    }
    else {
      to += right[j++]!.length
    }
  }

  return shared ? [changedLeft, changedRight] : undefined
}

// The line coloured as an added or removed one, its code highlighted in the file's language and the changed characters emphasised; an uncoloured stretch keeps the line's colour.
function paintContent({ mark, text, language }: Content, theme: Theme, changed: boolean[] | undefined): string {
  const tone = mark === '+' ? theme.added : theme.removed
  const code = text.slice(1)
  const source = language === undefined ? code : highlight(code, language, theme)
  const cells: { char: string, style: string, changed: boolean }[] = [{ char: mark, style: '', changed: false }]
  let style = ''
  let from = 0

  for (const escape of source.matchAll(ESCAPE)) {
    for (const char of source.slice(from, escape.index).split(''))
      cells.push({ char, style, changed: changed?.[cells.length - 1] ?? false })

    style = CLOSING.has(escape[1]!) ? '' : style + escape[0]
    from = escape.index + escape[0].length
  }

  for (const char of source.slice(from).split(''))
    cells.push({ char, style, changed: changed?.[cells.length - 1] ?? false })

  let out = ''

  for (let at = 0; at < cells.length;) {
    let end = at + 1

    while (end < cells.length && cells[end]!.style === cells[at]!.style && cells[end]!.changed === cells[at]!.changed)
      end++

    const run = cells.slice(at, end).map(cell => cell.char).join('')
    const shown = cells[at]!.style === '' ? tone(run) : `${cells[at]!.style}${run}\x1B[0m`

    out += cells[at]!.changed ? theme.changed(shown) : shown
    at = end
  }

  return out
}

// The diff coloured with the roles of the other CLIs: file names, hunk ranges, added and removed lines. A hunk's line counts tell its `--- ` content lines from the file headers.
export function renderDiff(text: string, theme: Theme): string {
  let oldLeft = 0
  let newLeft = 0
  let language: Name | undefined

  const lines = escapeControls(text.replace(GIT_COLOR, '').replaceAll('\r\n', '\n')).replace(TRAILING_NEWLINE, '').split('\n').map((line): string | Content => {
    // A line that cannot belong to a hunk means its counts were off, so the rest is read as headers again.
    if ((oldLeft > 0 || newLeft > 0) && line !== '' && !HUNK_LINE.has(line[0] ?? ''))
      oldLeft = newLeft = 0

    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0]

      if (mark === '+') {
        newLeft--

        return { mark, text: line, language }
      }

      if (mark === '-') {
        oldLeft--

        return { mark, text: line, language }
      }

      if (mark === '\\')
        return theme.dim(line)

      oldLeft--
      newLeft--

      return line
    }

    const hunk = HUNK.exec(line)

    if (hunk !== null) {
      oldLeft = Number(hunk[1] ?? 1)
      newLeft = Number(hunk[2] ?? 1)

      return `${theme.accent(line.slice(0, line.length - (hunk[3] ?? '').length))}${theme.dim(hunk[3] ?? '')}`
    }

    const file = FILE_HEADER.exec(line)

    if (file !== null) {
      language = languageOf(file[2] ?? '')

      return `${theme.dim('diff')} ${theme.bold(theme.path(file[2] ?? ''))}`
    }

    const commit = COMMIT.exec(line)

    if (commit !== null)
      return `${theme.dim(commit[1] ?? '')}${theme.id(commit[2] ?? '')}${theme.dim(commit[3] ?? '')}`

    const target = NEW_FILE.exec(line)?.[1]

    if (target !== undefined && target !== '/dev/null')
      language = languageOf(target)

    return MARKERS.test(line) || META.test(line) || COMMIT_META.test(line) ? theme.dim(line) : line
  })

  const changes = new Map<number, boolean[]>()

  // A run of removed lines followed at once by a run of added ones: the first of each, the second of each..., are the same line edited.
  for (let at = 0; at < lines.length;) {
    const first = lines[at]
    const isRemoved = typeof first === 'object' && first.mark === '-'

    if (!isRemoved) {
      at++

      continue
    }

    let split = at

    while (typeof lines[split] === 'object' && (lines[split] as Content).mark === '-')
      split++

    let end = split

    while (typeof lines[end] === 'object' && (lines[end] as Content).mark === '+')
      end++

    for (let pair = 0; pair < Math.min(split - at, end - split); pair++) {
      const flags = changedChars((lines[at + pair] as Content).text.slice(1), (lines[split + pair] as Content).text.slice(1))

      if (flags !== undefined) {
        changes.set(at + pair, flags[0])
        changes.set(split + pair, flags[1])
      }
    }

    at = Math.max(end, at + 1)
  }

  return `${lines.map((line, index) => typeof line === 'string' ? line : paintContent(line, theme, changes.get(index))).join('\n')}\n`
}
