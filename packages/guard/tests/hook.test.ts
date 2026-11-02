import type { HookInput, Machine } from '../src/hook'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { hook } from '../src/hook'

const REPO = '/work/repo'

function machine(files: Record<string, string> = {}, settings: Partial<Machine> = {}): Machine & { ran: string[][] } {
  const ran: string[][] = []

  return {
    home: '/home/me',
    stateDir: '/state',
    has: () => true,
    run: async (argv) => {
      ran.push(argv)

      return Promise.resolve({ code: 0, text: '' })
    },
    read: path => files[path] ?? null,
    exists: path => path in files,
    write: (path, text) => {
      files[path] = text
    },
    remove: (path) => {
      delete files[path]
    },
    ...settings,
    ran,
  }
}

// Shaped as Claude Code sends them, the fields guard never reads included.
function bash(command: string): HookInput {
  return { session_id: 'abc-123', cwd: REPO, tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_use_id: 'toolu_1', hook_event_name: 'PreToolUse', permission_mode: 'default' } as HookInput
}

function prompt(text: string): HookInput {
  return { session_id: 'abc-123', cwd: REPO, prompt: text, hook_event_name: 'UserPromptSubmit' } as HookInput
}

describe('pre-tool-use on Bash', () => {
  test('refuses a call breaking a rule, with its route', async () => {
    const reply = await hook('pre-tool-use', bash('git stash'), machine())

    expect(reply?.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('base') })
  })

  test('lets a clean call through untouched, out or not', async () => {
    expect(await hook('pre-tool-use', bash('bun run lint'), machine())).toBeNull()
  })

  test('refuses an install with the wrong manager, naming the command to run', async () => {
    const reply = await hook('pre-tool-use', bash('npm i left-pad'), machine({ [`${REPO}/bun.lock`]: '' }))

    expect(reply?.hookSpecificOutput.permissionDecisionReason).toContain('Run `bun add left-pad` instead.')
  })

  test('asks pkg about the packages a call adds, refusing what it refuses', async () => {
    const refusing = machine({}, { run: async () => Promise.resolve({ code: 1, text: 'left-pad: published 2 days ago\n' }) })
    const reply = await hook('pre-tool-use', bash('bun add left-pad'), refusing)

    expect(reply?.hookSpecificOutput.permissionDecisionReason).toBe('pkg refused what this adds, so it was not run:\nleft-pad: published 2 days ago')

    const passing = machine()

    expect(await hook('pre-tool-use', bash('bun add left-pad'), passing)).toBeNull()
    expect(passing.ran).toEqual([['pkg', 'check', 'left-pad']])
  })

  test('skips pkg when it is not installed', async () => {
    const bare = machine({}, { has: () => false })

    expect(await hook('pre-tool-use', bash('bun add left-pad'), bare)).toBeNull()
    expect(bare.ran).toEqual([])
  })
})

describe('pre-tool-use on file tools', () => {
  test('refuses a Read, Edit or Write of an env file', async () => {
    for (const tool of ['Read', 'Edit', 'Write']) {
      const reply = await hook('pre-tool-use', { tool_name: tool, tool_input: { file_path: `${REPO}/.env.local` } }, machine())

      expect(reply?.hookSpecificOutput.permissionDecision).toBe('deny')
    }
  })

  test('lets a template and any other file through', async () => {
    for (const path of ['.env.example', 'README.md'])
      expect(await hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: `${REPO}/${path}` } }, machine())).toBeNull()
  })
})

describe('the gc nudge', () => {
  const chain = 'git add src/a.ts "my file.ts" && git commit -m "$(cat <<\'EOF\'\nfix(api): retry a timed-out fetch\n\nA 502 is retried once.\n\n#12 - [UC3] Retry failed fetches\nEOF\n)"'

  test('names the gc line of a passing add and commit chain, without refusing it', async () => {
    const reply = await hook('pre-tool-use', bash(chain), machine())

    expect(reply?.hookSpecificOutput.permissionDecision).toBeUndefined()
    expect(reply?.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(reply?.hookSpecificOutput.additionalContext).toContain('`gc \'fix(api): retry a timed-out fetch\' -m \'A 502 is retried once.\' --ticket \'#12 - [UC3] Retry failed fetches\' -- \'src/a.ts\' \'my file.ts\'`')
  })

  test('says nothing of a commit gc cannot replace', async () => {
    for (const command of ['git commit -m "fix: x"', 'git add src/a.ts', 'git add -p src/a.ts && git commit -m "fix: x"', 'git add src/a.ts && git commit -F msg.txt', 'git add src/a.ts && git commit --amend --no-edit'])
      expect(await hook('pre-tool-use', bash(command), machine({ [`${REPO}/msg.txt`]: 'fix: x' }))).toBeNull()
  })

  test('keeps refusing a chain that breaks a rule, with the refusal alone', async () => {
    const reply = await hook('pre-tool-use', bash('git add src/a.ts && git commit -m "wip"'), machine())

    expect(reply?.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(reply?.hookSpecificOutput.additionalContext).toBeUndefined()
  })
})

describe('user-prompt-submit', () => {
  test('git push passes only while the latest prompt asked for one', async () => {
    const files: Record<string, string> = {}
    const state = machine(files)

    expect(await hook('pre-tool-use', bash('git push'), state)).not.toBeNull()

    await hook('user-prompt-submit', prompt('commit and push it'), state)
    expect(await hook('pre-tool-use', bash('git push'), state)).toBeNull()

    await hook('user-prompt-submit', prompt('now fix the test'), state)
    expect(await hook('pre-tool-use', bash('git push'), state)).not.toBeNull()
    expect(files).toEqual({})
  })

  test('keeps nothing for a session id that is no safe file name', async () => {
    const files: Record<string, string> = {}

    await hook('user-prompt-submit', { session_id: '../x', prompt: 'push' }, machine(files))
    expect(files).toEqual({})
  })
})

describe('session-start', () => {
  test('lists the installed bins only', async () => {
    const reply = await hook('session-start', { session_id: 'abc-123' }, machine({}, { has: bin => bin === 'ev' }))
    const text = reply?.hookSpecificOutput.additionalContext ?? ''

    expect(text).toContain('`ev`')
    expect(text).not.toContain('`db')
  })

  test('adds nothing when none is installed', async () => {
    expect(await hook('session-start', {}, machine({}, { has: () => false }))).toBeNull()
  })
})

describe('the bin', () => {
  const state = mkdtempSync(join(tmpdir(), 'guard-hook-'))

  async function run(args: string[], stdin: string) {
    const proc = Bun.spawn(['bun', `${import.meta.dir}/../src/cli.ts`, 'hook', ...args], { stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, XDG_STATE_HOME: state } })

    return { code: await proc.exited, stdout: await new Response(proc.stdout).text() }
  }

  test('prints the deny as JSON and exits 0', async () => {
    const { code, stdout } = await run(['pre-tool-use'], JSON.stringify({ ...bash('git stash'), cwd: import.meta.dir }))

    expect(code).toBe(0)
    expect((JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('keeps the push asked for in the state directory between runs', async () => {
    const push = JSON.stringify({ ...bash('git push'), cwd: import.meta.dir })

    await run(['user-prompt-submit'], JSON.stringify(prompt('push it')))
    expect(existsSync(`${state}/guard/push-asked/abc-123`)).toBe(true)
    expect(await run(['pre-tool-use'], push)).toEqual({ code: 0, stdout: '' })

    await run(['user-prompt-submit'], JSON.stringify(prompt('thanks')))
    expect(existsSync(`${state}/guard/push-asked/abc-123`)).toBe(false)
    expect((await run(['pre-tool-use'], push)).stdout).toContain('deny')
  })

  test('fails with 1, never the 2 that blocks, on a wrong event or input', async () => {
    expect((await run(['pre-tool-use'], 'not json')).code).toBe(1)
    expect((await run(['post-tool-use'], '{}')).code).toBe(1)
  })
})
