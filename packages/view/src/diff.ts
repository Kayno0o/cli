import type { Theme } from './theme'
import { stripAnsi } from '@kaynooo/cli-kit'

const TRAILING_NEWLINE = /\n$/
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(.*)$/
const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/
const COMMIT = /^(commit )([0-9a-f]{7,40})(.*)$/
const HUNK_LINE = new Set([' ', '+', '-', '\\'])
const MARKERS = /^(?:--- |\+\+\+ )/
const META = /^(?:index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch)/
const COMMIT_META = /^(?:Author|Date|Merge|AuthorDate|Commit|CommitDate):/

// Whether the text is a diff, a `git log -p` or a `git show`, by its first line.
export function looksLikeDiff(text: string): boolean {
  const first = stripAnsi(text).split('\n').find(line => line.trim() !== '') ?? ''

  return first.startsWith('diff --git ') || first.startsWith('--- ') || first.startsWith('@@ ') || first.startsWith('Index: ') || COMMIT.test(first)
}

// The diff coloured with the roles of the other CLIs: file names, hunk ranges, added and removed lines. A hunk's line counts tell its `--- ` content lines from the file headers.
export function renderDiff(text: string, theme: Theme): string {
  let oldLeft = 0
  let newLeft = 0

  const lines = stripAnsi(text).replaceAll('\r', '').replace(TRAILING_NEWLINE, '').split('\n').map((line) => {
    // A line that cannot belong to a hunk means its counts were off, so the rest is read as headers again.
    if ((oldLeft > 0 || newLeft > 0) && line !== '' && !HUNK_LINE.has(line[0] ?? ''))
      oldLeft = newLeft = 0

    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0]

      if (mark === '+') {
        newLeft--

        return theme.added(line)
      }

      if (mark === '-') {
        oldLeft--

        return theme.removed(line)
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

    if (file !== null)
      return `${theme.dim('diff')} ${theme.bold(theme.path(file[2] ?? ''))}`

    const commit = COMMIT.exec(line)

    if (commit !== null)
      return `${theme.dim(commit[1] ?? '')}${theme.id(commit[2] ?? '')}${theme.dim(commit[3] ?? '')}`

    return MARKERS.test(line) || META.test(line) || COMMIT_META.test(line) ? theme.dim(line) : line
  })

  return `${lines.join('\n')}\n`
}
