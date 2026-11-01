import type { Context, Violation } from './check'
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
}

const PUSH_WORDS = /\b(?:push|pousse)/i
const SESSION_ID = /^[\w-]+$/
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write'])

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
  })

  if (verdict.violations.length > 0 || verdict.packages.length === 0 || !machine.has('pkg'))
    return deny(verdict.violations)

  const checked = await machine.run(['pkg', 'check', ...verdict.packages], cwd)

  return checked.code === 1 ? deny([{ rule: 'pkg', message: `pkg refused what this adds, so it was not run:\n${checked.text.trim()}` }]) : null
}

function preToolUse(input: HookInput, machine: Machine): Promise<HookOutput | null> | HookOutput | null {
  const { tool_name: tool, tool_input: given = {} } = input

  if (tool === 'Bash' && typeof given.command === 'string')
    return bashCall(given.command, input, machine)

  if (tool !== undefined && FILE_TOOLS.has(tool) && typeof given.file_path === 'string')
    return deny([checkPath(given.file_path)].filter(each => each !== null))

  return null
}

// Claude Code tells no typed prompt from one it sends itself, so any prompt naming a push counts.
function userPromptSubmit(input: HookInput, machine: Machine): null {
  const file = pushFile(input.session_id, machine)

  if (file !== null && PUSH_WORDS.test(input.prompt ?? ''))
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
