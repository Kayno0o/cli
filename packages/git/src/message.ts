const CONVENTIONAL = /^[a-z]+(?:\([^()\n]+\))?!?: \S/
// Titles git writes itself.
const GIT_MADE = /^(?:Merge |Revert "|fixup! |squash! |amend! )/

export const TICKET = /^#\d+ - /
// A breaking change is the one place a body gives full details.
const BREAKING = /^BREAKING[ -]CHANGE: /
const BREAKING_TITLE = /^[a-z]+(?:\([^()\n]+\))?!: /
const TRAILER = /^(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|change-id):|^\W*generated with\b/i
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s/
const SENTENCE_END = /[.!?:;)\]`'"]$/
const LOWER_START = /^\p{Ll}/u

const FORMAT = 'A commit message is a `type(scope): title` line, then optionally a blank line, one or two lines on what changed and one `#<n> - <title>` line per ticket.'

export const TITLE = `The title is no Conventional Commit, its type and scope taken from the repository's history. ${FORMAT}`
export const TITLE_LINE = `The title takes one line and a blank line follows it. ${FORMAT}`
export const TRAILERS = `No trailers, ever: no Co-Authored-By, Signed-off-by or "Generated with" line, no --signoff or --trailer. ${FORMAT}`
export const BULLETS = `The body names what changed in a line or two, never a bullet list narrating the diff. ${FORMAT}`
export const TOO_LONG = `The body holds at most two lines besides the ticket lines; what goes beyond belongs in the reply. ${FORMAT}`
export const WRAPPED = `A body sentence stays on one line however long it runs: never hard-wrap it. ${FORMAT}`

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

  if (BREAKING_TITLE.test(title) || body.some(line => BREAKING.test(line)))
    return null

  const descriptions = body.filter(isDescription)

  if (descriptions.some(line => BULLET.test(line)))
    return BULLETS

  if (descriptions.length > 2)
    return TOO_LONG

  const isWrapped = body.some((line, i) => isDescription(line) && isDescription(body[i + 1]) && !SENTENCE_END.test(line) && LOWER_START.test(body[i + 1] ?? ''))

  return isWrapped ? WRAPPED : null
}
