import type { Session } from './sessions'

// The comments sessions post to take an issue and to give it back.
const TAKEN = /^\s*taken by session ([\w.@:-]+?)\.?\s*$/im
const RELEASED = /^\s*released by session ([\w.@:-]+?)\.?\s*$/im
// A kayjs lane is named lane-<n>-<issue> after the session it runs in, whose name ends in -<n>.
const LANE = /^lane-([^-]+)-/

export interface Comment { body: string, created_at: string }
export interface Claim { holder: string, at: string }

export function takenComment(name: string): string {
  return `Taken by session ${name}.`
}

export function releasedComment(name: string): string {
  return `Released by session ${name}.`
}

// The claim the comments leave standing: the latest one taking the issue, unless its holder released it since.
export function latestClaim(comments: Comment[]): Claim | undefined {
  let claim: Claim | undefined

  for (const comment of [...comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const taken = TAKEN.exec(comment.body)?.[1]

    if (taken !== undefined) {
      claim = { holder: taken, at: comment.created_at }

      continue
    }

    if (claim !== undefined && RELEASED.exec(comment.body)?.[1] === claim.holder)
      claim = undefined
  }

  return claim
}

// The latest comment that neither takes nor gives back the issue, which says where its work stands.
export function latestNote<T extends Comment>(comments: T[]): T | undefined {
  return comments.filter(comment => !TAKEN.test(comment.body) && !RELEASED.test(comment.body)).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1)
}

// The live session holding a claim: the one of that name, or for a lane the session it runs in.
export function holderSession(holder: string, sessions: Session[]): Session | undefined {
  const own = sessions.find(session => session.name === holder)

  if (own !== undefined)
    return own

  const lane = LANE.exec(holder)?.[1]

  return lane === undefined ? undefined : sessions.find(session => session.name.endsWith(`-${lane}`))
}
