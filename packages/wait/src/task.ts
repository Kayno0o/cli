import type { Line } from './conditions'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// The line Claude Code appends to a background Bash task's output once the command ends.
const EXITED = /(?:^|\n)\[exited with code (-?\d+)\]\n*$/
const FAILURE = /\(fail\)|\berror:/i
const TASK_ID = /^[\w-]+$/
// Bytes read from the end of the file to look for the exit line.
const TAIL_BYTES = 256
const LONGEST_FAILURES = 30

const CARRIAGE_RETURN = /\r$/

export interface TaskEnd {
  // The `(fail)` and `error:` lines before the tail, the last LONGEST_FAILURES of them.
  failures: Line[]
  tail: Line[]
}

// Where Claude Code keeps its background tasks' output, `<tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output`.
function tasksRoot(env: Record<string, string | undefined>): string {
  return join(env.CLAUDE_CODE_TMPDIR ?? env.TMPDIR ?? '/tmp', `claude-${process.getuid?.() ?? 0}`)
}

// The output file of a task given by id or by path, undefined when no session holds the id.
export function taskFile(task: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (task.includes('/') || task.endsWith('.output'))
    return task

  if (!TASK_ID.test(task))
    return undefined

  const root = tasksRoot(env)
  const found = existsSync(root) ? [...new Bun.Glob(`*/*/tasks/${task}.output`).scanSync({ cwd: root, onlyFiles: false })] : []

  return found.length === 0 ? undefined : join(root, found[0] ?? '')
}

// Whether the file is a subagent's transcript, which Claude Code links in place of an output.
export function isTranscript(path: string): boolean {
  return existsSync(path) && lstatSync(path).isSymbolicLink() && path.endsWith('.output')
}

// The exit code once the file ends on the exit line, undefined while the task runs or the file is missing.
export async function exitCode(path: string): Promise<number | undefined> {
  if (!existsSync(path))
    return undefined

  const size = statSync(path).size
  const found = EXITED.exec(await Bun.file(path).slice(Math.max(0, size - TAIL_BYTES), size).text())

  return found === null ? undefined : Number(found[1])
}

// What the task printed last: its last `lines` lines before the exit line, and the failure lines above them.
export async function taskEnd(path: string, lines: number): Promise<TaskEnd> {
  if (!existsSync(path))
    return { failures: [], tail: [] }

  const text = (await Bun.file(path).text()).replace(EXITED, '')
  const all = text.split('\n').map((line, i) => ({ number: i + 1, text: Bun.stripANSI(line.replace(CARRIAGE_RETURN, '')) }))

  while (all.at(-1)?.text.trim() === '')
    all.pop()

  const tail = all.slice(-lines)
  const first = tail[0]?.number ?? Infinity

  return { failures: all.filter(line => line.number < first && FAILURE.test(line.text)).slice(-LONGEST_FAILURES), tail }
}

// Whether a process holds the pid, asked with signal 0, which only checks; unlike `pgrep -f`, it never matches the shell asking.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  }
  catch (error) {
    // EPERM: the process exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }

  return !isZombie(pid)
}

// A zombie has ended and only waits for its parent to reap it, which a wait for it to exit should not outlast; its state is the letter after the command in parentheses in /proc/<pid>/stat.
function isZombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')

    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z'
  }
  catch {
    return false
  }
}
