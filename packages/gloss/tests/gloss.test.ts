import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/gloss.ts', import.meta.url).pathname

function gloss(args: string[], stdin = '') {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1', MANPATH: '/nonexistent' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('gloss', () => {
  test('lists a command with no man page and joins what the operators do', () => {
    const { code, out } = gloss(['zz-nope -x file | zz-other > out'])

    expect(code).toBe(0)
    expect(out).toContain('zz-nope  no man page found')
    expect(out).toContain('| pipes the output into the next command')
    expect(out).toContain('> out  writes the output to out')
  })

  test('takes the words after -- and quotes the ones that need it', () => {
    expect((JSON.parse(gloss(['--json', '--', 'zz-nope', 'a b']).out) as { commands: { notes: unknown[] }[] }).commands[0]?.notes).toMatchObject([{ token: 'a b', kind: 'argument' }])
  })

  test('reads the command line from stdin', () => {
    expect(gloss([], 'zz-nope -x\n').out).toContain('zz-nope')
  })

  test('refuses an empty command line', () => {
    expect(gloss([], '')).toMatchObject({ code: 2, err: expect.stringContaining('command line') })
  })
})
