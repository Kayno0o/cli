import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { analyze } from '../src/analyze'

const dir = mkdtempSync(join(tmpdir(), 'gloss-help-'))

function tool(name: string, body: string): void {
  const path = join(dir, name)

  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

tool('zzdemo', `cat <<'TEXT'
A demo tool

Usage: zzdemo [options] FILE

-q, --quiet          print nothing
-o, --output FILE    write to FILE
TEXT`)
tool('zzsub', `if [ "$1" = run ]; then echo "  -w, --watch   rerun on change" >&2; else echo "Usage: zzsub <command>"; fi`)
tool('zzmark', `echo ran > "${dir}/marker"`)

const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, MANPATH: '/nonexistent' }

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('man pages', () => {
  test('finds the page of a command given by its path under its name', () => {
    mkdirSync(join(dir, 'man/man1'), { recursive: true })
    writeFileSync(join(dir, 'man/man1/zzpage.1'), '.TH ZZPAGE 1\n.SH NAME\nzzpage \\- a demo\n.SH OPTIONS\n.TP\n\\fB\\-l\\fR\nuse a long listing format\n')

    const [command] = analyze('/usr/bin/zzpage -l', { env: { ...env, MANPATH: join(dir, 'man') } }).commands

    expect(command?.notes[0]?.text).toContain('use a long listing format')
  })
})

describe('--run-help', () => {
  test('reads the options of a command with no man page from its help', () => {
    const [gloss] = analyze('zzdemo -q -o out.txt in', { env, runHelp: true }).commands

    expect(gloss).toMatchObject({ source: 'help', summary: 'A demo tool' })
    expect(gloss?.notes.map(note => [note.kind, note.token, note.text])).toEqual([['option', '-q', 'print nothing'], ['option', '-o', 'write to FILE'], ['value', 'out.txt', 'the FILE for -o'], ['argument', 'in', undefined]])
  })

  test('does not run anything without the flag', () => {
    expect(analyze('zzdemo -q', { env }).commands[0]).toMatchObject({ source: undefined, page: undefined })
  })

  test('reads a subcommand\'s help, from stderr too', () => {
    const [gloss] = analyze('zzsub run -w', { env, runHelp: true }).commands

    expect(gloss).toMatchObject({ name: 'zzsub run', source: 'help' })
    expect(gloss?.notes.map(note => note.token)).toEqual(['-w'])
  })

  test('runs only a bare name found on PATH', () => {
    analyze('./zzmark', { env: { ...env, PATH: `${dir}:${process.env.PATH}` }, runHelp: true })
    analyze('/nope/zzdemo -q', { env, runHelp: true })

    expect(Bun.file(join(dir, 'marker')).size).toBe(0)
  })
})
