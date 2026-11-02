const CONVENTIONAL = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^()\n]+\))?!?: \S/
const MAX_TITLE = 100
// Titles git writes itself.
const GIT_MADE = /^(?:Merge |Revert "|fixup! |squash! |amend! )/

// `#12 - <title>`, or `owner/repo#12 - <title>` for a ticket of another repository.
export const TICKET = /^(?:[\w.-]+\/[\w.-]+)?#\d+ - /
// A breaking change is the one place a body gives full details.
const BREAKING = /^BREAKING[ -]CHANGE: /
const BREAKING_TITLE = /^[a-z]+(?:\([^()\n]+\))?!: /
const TRAILER = /^(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|change-id):|^\W*generated with \W*claude/i
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s/
const SENTENCE_END = /[.!?:;)\]`'"]$/
const LOWER_START = /^\p{Ll}/u

// The whole rule, so a refusal needs no other read.
export const RULE = 'The rule: a `type(scope): title` line, `!` after the scope for a breaking change, type and scope taken from the repository\'s history; then optionally a blank line and one or two lines on what changed, never a bullet list or a hard-wrapped sentence; then a blank line and one line per ticket, its title copied verbatim, `#<n> - <title>` (`owner/repo#<n> - <title>` for another repository). The message ends there: no Co-Authored-By, Signed-off-by or "Generated with" trailer. Only a breaking change gives full details.'

export const TITLE = `The title is no Conventional Commit. ${RULE}`
export const TITLE_TOO_LONG = `The title runs past ${MAX_TITLE} characters: shorten it and move the detail to the body. ${RULE}`
export const TITLE_LINE = `The title takes one line and a blank line follows it. ${RULE}`
export const TRAILERS = `No trailers, ever: no Co-Authored-By, Signed-off-by or "Generated with" line, no --signoff or --trailer. ${RULE}`
export const BULLETS = `The body names what changed in a line or two, never a bullet list narrating the diff. ${RULE}`
export const TOO_LONG = `The body holds at most two lines besides the ticket lines; what goes beyond belongs in the reply. ${RULE}`
export const WRAPPED = `A body sentence stays on one line however long it runs: never hard-wrap it. ${RULE}`

// Where a refused `git commit` is pointed, gc building the message from its parts.
export const USE_GC = 'Commit with `gc`, which stages exactly the paths given once the message keeps the rule: `gc \'fix(api): retry a timed-out fetch\' -m \'A 502 is retried once before failing.\' --ticket \'#12 - [UC3] Retry failed fetches\' -- src/api.ts`.'

function isDescription(line: string | undefined): boolean {
  return line !== undefined && line !== '' && !TICKET.test(line)
}

// Which commit message rule the message breaks, as the sentence to show, or null when it keeps them all.
export function commitMessageViolation(message: string): string | null {
  const lines = message.split('\n').map(line => line.trimEnd())

  while (lines[0] === '')
    lines.shift()

  while (lines.at(-1) === '')
    lines.pop()

  const [title = '', second, ...body] = lines

  if (title === '')
    return null

  if (lines.some(line => TRAILER.test(line)))
    return TRAILERS

  if (!CONVENTIONAL.test(title) && !GIT_MADE.test(title))
    return TITLE

  if (second !== undefined && second !== '')
    return TITLE_LINE

  if (!GIT_MADE.test(title) && title.length > MAX_TITLE)
    return TITLE_TOO_LONG

  if (BREAKING_TITLE.test(title))
    return null

  const footer = body.findIndex(line => BREAKING.test(line))
  const described = footer === -1 ? body : body.slice(0, footer)
  const descriptions = described.filter(isDescription)

  if (descriptions.some(line => BULLET.test(line)))
    return BULLETS

  if (descriptions.length > 2)
    return TOO_LONG

  const isWrapped = described.some((line, i) => isDescription(line) && isDescription(described[i + 1]) && !SENTENCE_END.test(line) && LOWER_START.test(described[i + 1] ?? ''))

  return isWrapped ? WRAPPED : null
}
