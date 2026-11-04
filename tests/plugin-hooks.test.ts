import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

const made: string[] = []

afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))

  made.push(dir)

  return dir
}

const GUARD = new URL('../packages/guard/src/cli.ts', import.meta.url).pathname
const HOOKS = new URL('../plugin/hooks/hooks.json', import.meta.url).pathname

interface Entry { matcher?: string, hooks: { command: string }[] }
interface Reply { hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }

// Stands in for the installed bin the plugin command points at, running the source instead of the built file.
function installGuard(): { home: string, bun: string } {
  const bun = tempDir('hook-bun-')
  const home = tempDir('hook-home-')

  mkdirSync(join(bun, 'bin'))
  writeFileSync(join(bun, 'bin', 'guard'), `#!/bin/sh\nexec "${process.execPath}" "${GUARD}" "$@"\n`)
  chmodSync(join(bun, 'bin', 'guard'), 0o755)

  return { home, bun }
}

async function manifest(): Promise<Record<string, Entry[]>> {
  return ((await Bun.file(HOOKS).json()) as { hooks: Record<string, Entry[]> }).hooks
}

async function fire(event: string, input: object): Promise<{ code: number, out: string }> {
  const [entry] = (await manifest())[event]!
  const { home, bun } = installGuard()
  const proc = Bun.spawn(['sh', '-c', entry!.hooks[0]!.command], { stdin: new Response(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe', cwd: home, env: { ...process.env, HOME: home, BUN_INSTALL: bun, NO_COLOR: '1' } })
  const out = await new Response(proc.stdout).text()

  return { code: await proc.exited, out }
}

function pre(tool_name: string, tool_input: object): object {
  return { session_id: 'e2e-1', cwd: '/work/repo', tool_name, tool_input, tool_use_id: 'toolu_1', hook_event_name: 'PreToolUse', permission_mode: 'default' }
}

describe('plugin hooks.json', () => {
  test('matches every tool guard answers, through the installed bin', async () => {
    const [entry] = (await manifest()).PreToolUse!

    for (const tool of ['Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Grep', 'Glob'])
      expect(new RegExp(`^(?:${entry!.matcher})$`).test(tool)).toBe(true)

    expect(entry!.hooks[0]!.command).toContain('guard" hook pre-tool-use')
  })

  test('denies a Bash call breaking a rule, with its route', async () => {
    const { code, out } = await fire('PreToolUse', pre('Bash', { command: 'git stash', description: 'x' }))
    const reply = JSON.parse(out) as Reply

    expect(code).toBe(0)
    expect(reply.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain('base')
  })

  test('says nothing of a clean Bash call', async () => {
    expect(await fire('PreToolUse', pre('Bash', { command: 'bun run lint' }))).toEqual({ code: 0, out: '' })
  })

  test('denies a Read and an Edit of an env file, lets a template through', async () => {
    for (const tool of ['Read', 'Edit']) {
      const reply = JSON.parse((await fire('PreToolUse', pre(tool, { file_path: '/work/repo/.env.local' }))).out) as Reply

      expect(reply.hookSpecificOutput.permissionDecision).toBe('deny')
    }

    expect(await fire('PreToolUse', pre('Read', { file_path: '/work/repo/.env.example' }))).toEqual({ code: 0, out: '' })
  })

  test('answers user-prompt-submit and session-start without failing', async () => {
    expect((await fire('UserPromptSubmit', { session_id: 'e2e-1', cwd: '/work/repo', prompt: 'hello', hook_event_name: 'UserPromptSubmit' })).code).toBe(0)
    expect((await fire('SessionStart', { session_id: 'e2e-1', cwd: '/work/repo', hook_event_name: 'SessionStart', source: 'startup' })).code).toBe(0)
  })
})
