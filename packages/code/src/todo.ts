import type { Chunk } from '@kaynooo/cli-kit'
import { runCommand } from '@kaynooo/cli-kit'

export interface Ref {
  repo: string
  number: number
}

export interface Mark {
  path: string
  line: number
  // TODO or FIXME when the comment carries one, else ref for a comment naming an issue.
  kind: 'TODO' | 'FIXME' | 'ref'
  text: string
  refs: Ref[]
}

// Where a comment opens: `//` (not a URL's), `/*`, `<!--`, a `#` or `--` standing alone, or the `*` leading a block comment's line.
const COMMENT = /(?<![:\w/])\/\/|\/\*|<!--|(?:^|\s)(?:#|--)(?=\s)|^\s*\*(?=\s|$)/
// Markup, where `#` opens a heading and `*` a list item: only `<!--` opens a comment there.
const MARKUP = /\.(?:md|mdx|markdown|html?|xml)$/i
const MARKUP_COMMENT = /<!--/
const CLOSERS = /\s*(?:\*\/|-->)\s*$/
// A marker opens the comment, so one naming the word in prose is no TODO.
const MARKER = /^(?:@|\[)?(TODO|FIXME)\b/
const QUOTES = ['\'', '"', '`']
const ESCAPE = /\\./g
const AFTER_FIRST_LINE = /\n[\s\S]*/
// An owner and a repository as a forge names them, never `.` or `..` and no leading dash, so a match is neither a path nor an option.
const REF = /(?<![\w./-])(\w[\w.-]*\/(?!\.+#)[\w.][\w.-]*)#(\d+)\b/g

// Whether the index sits inside a string the line opened, a quote of one kind left unclosed before it.
function isQuoted(line: string, index: number): boolean {
  const before = line.slice(0, index).replaceAll(ESCAPE, '')

  return QUOTES.some(quote => before.split(quote).length % 2 === 0)
}

// The TODO, FIXME and owner/repo#N comments of a file's text, one mark per comment line.
export function marksIn(text: string, path: string): Mark[] {
  const marks: Mark[] = []
  const comment = MARKUP.test(path) ? MARKUP_COMMENT : COMMENT

  for (const [i, line] of text.split('\n').entries()) {
    const opener = comment.exec(line)

    if (opener === null || isQuoted(line, opener.index))
      continue

    const body = line.slice(opener.index + opener[0].length).replace(CLOSERS, '').trim()
    const marker = MARKER.exec(body)?.[1] as Mark['kind'] | undefined
    const refs = [...body.matchAll(REF)].map(found => ({ repo: found[1] ?? '', number: Number(found[2]) }))

    if (marker !== undefined || refs.length > 0)
      marks.push({ path, line: i + 1, kind: marker ?? 'ref', text: body, refs })
  }

  return marks
}

function stdoutOf(chunks: Chunk[]): string {
  return Buffer.concat(chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.data)).toString()
}

export interface Lookup {
  // `owner/repo#n` to the issue's state.
  states: Map<string, string>
  // The repositories ft could not look up, with the first line it printed.
  failed: Map<string, string>
}

export function refKey(ref: Ref): string {
  return `${ref.repo}#${ref.number}`
}

// Each issue's state on GitHub through gh, for a repository Forgejo does not have, one call per issue.
async function lookUpOnGitHub(repo: string, numbers: readonly string[], cwd: string): Promise<Map<string, string> | string> {
  const states = new Map<string, string>()

  for (const ran of await Promise.all(numbers.map(async number => ({ number, ran: await runCommand(['gh', 'api', `repos/${repo}/issues/${number}`, '--jq', '.state'], { cwd }) })))) {
    if (ran.ran.code !== 0)
      return ran.ran.text.trim().replace(AFTER_FIRST_LINE, '')

    states.set(refKey({ repo, number: Number(ran.number) }), stdoutOf(ran.ran.chunks).trim())
  }

  return states
}

// Each issue's state, one `ft issue --json` call per repository, gh asked for a repository ft cannot reach.
export async function lookUp(refs: readonly Ref[], cwd: string): Promise<Lookup> {
  const lookup: Lookup = { states: new Map(), failed: new Map() }
  const byRepo = Map.groupBy(refs, ref => ref.repo)

  for (const [repo, ofRepo] of byRepo) {
    const numbers = [...new Set(ofRepo.map(ref => String(ref.number)))]
    const ran = Bun.which('ft') === null ? undefined : await runCommand(['ft', 'issue', ...numbers, '-r', repo, '--json'], { cwd })

    if (ran === undefined || ran.code !== 0) {
      const onGitHub = Bun.which('gh') === null ? 'gh is not installed' : await lookUpOnGitHub(repo, numbers, cwd)

      if (typeof onGitHub === 'string') {
        lookup.failed.set(repo, `ft: ${ran === undefined ? 'not installed' : ran.text.trim().replace(AFTER_FIRST_LINE, '')}; gh: ${onGitHub}`)
      }
      else {
        for (const [key, state] of onGitHub) lookup.states.set(key, state)
      }

      continue
    }

    const parsed = JSON.parse(stdoutOf(ran.chunks)) as { number: number, state: string } | { number: number, state: string }[]

    for (const issue of Array.isArray(parsed) ? parsed : [parsed])
      lookup.states.set(refKey({ repo, number: issue.number }), issue.state)
  }

  return lookup
}
