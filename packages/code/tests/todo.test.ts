import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { marksIn } from '../src/todo'

const CLI = new URL('../src/todo-scan.ts', import.meta.url).pathname

let dir = ''

function write(path: string, text: string) {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}

function scan(args: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-scan-'))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  write('.gitignore', 'ignored/\n')
  write('src/a.ts', 'const url = \'https://x.dev/TODO\'\n// TODO: drop once released\nfoo() // kaynooo/kayjs#823\n/* FIXME kaynooo/kayjs#9 too */\nconst s = \'TODO in a string\'\n')
  write('notes.md', '# TODO list\n<!-- TODO: say more -->\n')
  write('ignored/b.ts', '// TODO: hidden\n')
  write('script.sh', '#!/bin/sh\n# owner/repo#4 waits on this\n')
})

describe('marksIn', () => {
  test('reads the markers and references of comments only', () => {
    expect(marksIn('x = 1 # TODO(me): later\n * FIXME: block line\nlet y = a // b\n', 'a.py').map(mark => [mark.line, mark.kind, mark.text])).toEqual([[1, 'TODO', 'TODO(me): later'], [2, 'FIXME', 'FIXME: block line']])
    expect(marksIn('// ../..#1 and a/..#2 and -x/y#3 and ok/repo#4 and a/.github#5\n', 'a.ts').flatMap(mark => mark.refs.map(ref => `${ref.repo}#${ref.number}`))).toEqual(['ok/repo#4', 'a/.github#5'])
    expect(marksIn('// the TODO and FIXME comments\nconst s = \'a // TODO: in a string\'\n', 'a.ts')).toEqual([])
    expect(marksIn('// see kaynooo/kayjs#823 and acme/x#2\n', 'a.ts')[0]?.refs).toEqual([{ repo: 'kaynooo/kayjs', number: 823 }, { repo: 'acme/x', number: 2 }])
  })
})

describe('todo-scan', () => {
  test('lists the comments of the files git keeps, ignored ones left out', () => {
    expect(scan([])).toEqual({ code: 0, out: 'notes.md:2: TODO: say more\nscript.sh:2: owner/repo#4 waits on this\nsrc/a.ts:2: TODO: drop once released\nsrc/a.ts:3: kaynooo/kayjs#823\nsrc/a.ts:4: FIXME kaynooo/kayjs#9 too\n', err: '' })
    expect(scan(['src']).out.split('\n')).toHaveLength(4)
  })

  test('caps the list with --limit, counting the rest, and leaves JSON whole', () => {
    expect(scan(['--limit', '2']).out).toBe('notes.md:2: TODO: say more\nscript.sh:2: owner/repo#4 waits on this\n3 more, rerun with --full\n')
    expect(scan(['--full']).out.split('\n')).toHaveLength(6)
    expect((JSON.parse(scan(['--json']).out) as unknown[]).length).toBe(5)
  })

  test('prints JSON', () => {
    expect((JSON.parse(scan(['--json', 'src']).out) as { kind: string }[]).map(mark => mark.kind)).toEqual(['TODO', 'ref', 'FIXME'])
  })

  // Stand-in ft and gh: kayjs#823 closed and #9 open on Forgejo, owner/repo unknown to ft, and to gh unless `gh` is given.
  function standIns(gh = 'echo "gh: Not Found (HTTP 404)" >&2; exit 1') {
    const bin = join(dir, 'ignored', 'bin')

    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'ft'), '#!/bin/sh\ncase "$*" in\n  *kaynooo/kayjs*) echo \'[{"number":823,"state":"closed"},{"number":9,"state":"open"}]\' ;;\n  *) echo "error: no repository owner/repo" >&2; exit 1 ;;\nesac\n')
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${gh}\n`)
    chmodSync(join(bin, 'ft'), 0o755)
    chmodSync(join(bin, 'gh'), 0o755)

    return { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  }

  test('keeps the comments naming a closed issue with --stale, exiting 1', () => {
    const result = scan(['--stale'], standIns())

    expect(result.code).toBe(1)
    expect(result.out).toBe('src/a.ts:3: kaynooo/kayjs#823 closed: kaynooo/kayjs#823\n')
    expect(result.err).toContain('could not look owner/repo up')
  })

  test('exits 2, not 0, when every lookup failed', () => {
    write('src/a.ts', '// owner/repo#4 waits\n')
    write('notes.md', '')
    write('script.sh', '')

    const result = scan(['--stale'], standIns())

    expect(result.code).toBe(2)
    expect(result.out).toBe('')
    expect(result.err).toContain('could not look owner/repo up')
  })

  test('asks gh for a repository ft cannot reach', () => {
    const result = scan(['--stale'], standIns('[ "$2" = repos/owner/repo/issues/4 ] && echo closed'))

    expect(result.out).toBe('script.sh:2: owner/repo#4 closed: owner/repo#4 waits on this\nsrc/a.ts:3: kaynooo/kayjs#823 closed: kaynooo/kayjs#823\n')
    expect(result.err).toBe('')
  })

  test('names what gh answered when it cannot look an issue up', () => {
    const result = scan(['--stale'], standIns('echo "HTTP 404: Not Found" >&2; exit 1'))

    expect(result.code).toBe(1)
    expect(result.err).toContain('HTTP 404: Not Found')
  })
})
