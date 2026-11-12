import type { Session } from '@kaynooo/cli-kit'

// The comments sessions post to take an issue and to give it back, a name being any text on that one line.
const TAKEN = /^taken by session (.+)$/i
const RELEASED = /^released by session (.+)$/i
// What a claim comment could not carry and read back as the same name, and the clause punctuation that marks a sentence going on past a name.
const UNCLAIMABLE = /^\s|\s$|[\p{Cc}\u2028\u2029]|[,;:]\s/u
// A kayjs lane is named lane-<n>-<issue> after the session it runs in, whose name ends in -<n>.
const LANE = /^lane-([^-]+)-/

export interface Comment { body: string, created_at: string, user?: { login: string } }
export interface Claim { holder: string, at: string }

export function takenComment(name: string): string {
  return `Taken by session ${name}.`
}

export function releasedComment(name: string): string {
  return `Released by session ${name}.`
}

// Whether a claim comment reads the name back as it is.
export function claimable(name: string): boolean {
  return name !== '' && !UNCLAIMABLE.test(name)
}

// The name a comment made of that sentence alone carries, its final dot left out; a name no claim could carry is prose, not a claim.
function named(sentence: RegExp, body: string): string | undefined {
  const name = sentence.exec(body.trim())?.[1]
  const bare = name?.endsWith('.') === true ? name.slice(0, -1) : name

  return bare !== undefined && claimable(bare) ? bare : undefined
}

// A claim is a comment made of that sentence alone, so a quote or a code block mentioning it claims nothing; given an author, only that user's comments count, as every session posts under the same login.
function isClaimant(comment: Comment, author: string | undefined): boolean {
  return author === undefined || comment.user === undefined || comment.user.login === author
}

// The claim the comments leave standing: the latest one taking the issue, unless its holder released it since.
export function latestClaim(comments: Comment[], author?: string): Claim | undefined {
  let claim: Claim | undefined

  for (const comment of comments.filter(each => isClaimant(each, author)).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const taken = named(TAKEN, comment.body)

    if (taken !== undefined) {
      claim = { holder: taken, at: comment.created_at }

      continue
    }

    if (claim !== undefined && named(RELEASED, comment.body) === claim.holder)
      claim = undefined
  }

  return claim
}

// What a lane started from this session is named after: the part of its name after the last dash.
export function laneSuffix(session: string): string | undefined {
  const suffix = session.slice(session.lastIndexOf('-') + 1)

  return session.includes('-') && suffix !== '' ? suffix : undefined
}

// The latest comment that neither takes nor gives back the issue, which says where its work stands.
export function latestNote<T extends Comment>(comments: T[]): T | undefined {
  return comments.filter(comment => named(TAKEN, comment.body) === undefined && named(RELEASED, comment.body) === undefined).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1)
}

// The live session holding a claim: the one of that name, or for a lane the session it runs in.
export function holderSession(holder: string, sessions: Session[]): Session | undefined {
  const own = sessions.find(session => session.name === holder)

  if (own !== undefined)
    return own

  const lane = LANE.exec(holder)?.[1]

  return lane === undefined ? undefined : sessions.find(session => session.name.endsWith(`-${lane}`))
}
