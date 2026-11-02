import type { Context, Violation } from './check'
import { isEnvFile } from '@kaynooo/env-tools/guard'
import { BINS, binsSection } from './bins'
import { checkCommand, checkPath } from './check'

export const EVENTS = ['pre-tool-use', 'user-prompt-submit', 'session-start'] as const
export type Event = typeof EVENTS[number]

// The fields of a Claude Code hook event the rules read; the rest is ignored.
export interface HookInput {
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  prompt?: string
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' | 'SessionStart'
    permissionDecision?: 'deny'
    permissionDecisionReason?: string
    additionalContext?: string
  }
}

// What a hook may learn of the machine and do on it, swapped for fakes in tests.
export interface Machine {
  home: string
  // Where the per-session state lives across hook runs.
  stateDir: string
  has: (bin: string) => boolean
  // Runs a bin to its exit code and output.
  run: (argv: string[], cwd: string) => Promise<{ code: number, text: string }>
  read: Context['read']
  exists: Context['exists']
  write: (path: string, text: string) => void
  remove: (path: string) => void
  // Keeps a line of the guard's error log, when the machine has one.
  log?: (text: string) => void
}

const PUSH_WORD = /\b(?:push|pousser?|poussez)\b/i
// A push named as a thing rather than asked for: `push notifications`.
const PUSH_NOUN = /\bpush[\s-]+(?:notifications?|messages?|tokens?|events?|services?|apis?|subscriptions?|workers?|servers?)\b/gi
// Words that turn a mention of a push into a refusal, a question about the past or a statement.
const NOT_A_REQUEST = /\b(?:don'?t|do not|never|not|no|without|avoid|stop|can'?t|cannot|won'?t|shouldn'?t|did|didn'?t|does|doesn'?t|already|ne|pas|jamais|sans|surtout)\b/i
const CLAUSE_BREAKS = /[.!?;,\n]+/
const SESSION_ID = /^[\w-]+$/
// The tools reading or writing the file their input names, by that input's field.
const FILE_TOOLS = new Map([['Read', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['Write', 'file_path'], ['NotebookEdit', 'notebook_path'], ['Grep', 'path'], ['Glob', 'path']])
// A git command that prints what a tracked file holds.
const GIT_WORD = /\bgit\b/
const GIT_PRINT_WORD = /\b(?:diff|log|show|whatchanged|format-patch|grep)\b/
const TRACKED_ENV = [':(glob)**/.env', ':(glob)**/.env.*', ':(glob)**/.envrc']

// Whether a prompt asks for a push: a clause naming it that neither refuses it nor asks about the past.
export function asksForPush(prompt: string): boolean {
  return prompt.split(CLAUSE_BREAKS).some((clause) => {
    const asked = clause.replace(PUSH_NOUN, '')

    return PUSH_WORD.test(asked) && !NOT_A_REQUEST.test(asked)
  })
}

// The file holding whether the session's latest prompt asked for a push, null for an id that is no safe file name.
function pushFile(sessionId: string | undefined, { stateDir }: Machine): string | null {
  return sessionId !== undefined && SESSION_ID.test(sessionId) ? `${stateDir}/push-asked/${sessionId}` : null
}

function deny(violations: Violation[]): HookOutput | null {
  if (violations.length === 0)
    return null

  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: violations.map(each => each.message).join('\n\n') } }
}

// A Claude Code hook cannot swap the command without also approving or asking for it, so a rule that would rewrite refuses with the command to run instead, and nothing goes through out.
async function bashCall(command: string, input: HookInput, machine: Machine): Promise<HookOutput | null> {
  const file = pushFile(input.session_id, machine)
  const cwd = input.cwd ?? machine.home
  const verdict = await checkCommand(command, {
    cwd,
    home: machine.home,
    isPushAsked: file !== null && machine.exists(file),
    canRewrite: false,
    canWrap: false,
    canSub: machine.has('sub'),
    read: machine.read,
    exists: machine.exists,
    hasTrackedEnv: GIT_WORD.test(command) && GIT_PRINT_WORD.test(command) && await hasTrackedEnv(cwd, machine),
    onError: (rule, error, each) => machine.log?.(`${new Date().toISOString()} ${rule} crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n  command: ${each}\n`),
  })

  if (verdict.violations.length > 0 || verdict.packages.length === 0 || !machine.has('pkg'))
    return deny(verdict.violations)

  const checked = await machine.run(['pkg', 'check', ...verdict.packages], cwd)

  if (checked.code === 0)
    return null

  const message = checked.code === 1 ? 'pkg refused what this adds, so it was not run' : `pkg check failed (exit ${checked.code}), so what this adds was not checked and it was not run`

  return deny([{ rule: 'pkg', message: `${message}:\n${checked.text.trim()}` }])
}

// Whether the repository tracks an env file, so a diff or a log of it would print secrets.
async function hasTrackedEnv(cwd: string, machine: Machine): Promise<boolean> {
  const listed = await machine.run(['git', 'ls-files', '-z', '--', ...TRACKED_ENV], cwd)

  return listed.code === 0 && listed.text.split('\0').some(isEnvFile)
}

function preToolUse(input: HookInput, machine: Machine): Promise<HookOutput | null> | HookOutput | null {
  const { tool_name: tool, tool_input: given = {} } = input

  if (tool === 'Bash' && typeof given.command === 'string')
    return bashCall(given.command, input, machine)

  const field = tool === undefined ? undefined : FILE_TOOLS.get(tool)
  const paths = [field === undefined ? undefined : given[field], tool === 'Grep' ? given.glob : undefined]

  return deny(paths.flatMap(path => typeof path === 'string' ? [checkPath(path)] : []).filter(each => each !== null))
}

// Claude Code tells no typed prompt from one it sends itself, so any prompt naming a push counts.
function userPromptSubmit(input: HookInput, machine: Machine): null {
  const file = pushFile(input.session_id, machine)

  if (file !== null && asksForPush(input.prompt ?? ''))
    machine.write(file, '')
  else if (file !== null)
    machine.remove(file)

  return null
}

function sessionStart(machine: Machine): HookOutput | null {
  const text = binsSection(new Set(Object.keys(BINS).filter(machine.has)))

  return text === undefined ? null : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }
}

// The answer to one hook event, null when the call goes ahead with nothing to add.
export async function hook(event: Event, input: HookInput, machine: Machine): Promise<HookOutput | null> {
  if (event === 'pre-tool-use')
    return preToolUse(input, machine)

  return event === 'user-prompt-submit' ? userPromptSubmit(input, machine) : sessionStart(machine)
}
