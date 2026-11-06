import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { scriptArgs } from '../src/argv'
import { tempDirs } from '../src/test'

const temp = tempDirs()

const SCRIPT = '/bin/gp.js'

describe('scriptArgs', () => {
  test('puts back the -- Bun dropped right after the script', () => {
    expect(scriptArgs(['--tags'], ['bun', '--no-env-file', SCRIPT, '--', '--tags'], SCRIPT)).toEqual(['--', '--tags'])
  })

  test('leaves the arguments alone when nothing was dropped', () => {
    expect(scriptArgs(['a', '--', 'b'], ['bun', SCRIPT, 'a', '--', 'b'], SCRIPT)).toEqual(['a', '--', 'b'])
    expect(scriptArgs(['--tags'], ['bun', SCRIPT, '--tags'], SCRIPT)).toEqual(['--tags'])
  })

  test('a command line it cannot match to the script gives the arguments as Bun passed them', () => {
    expect(scriptArgs(['--tags'], ['/$bunfs/root/gp', '--', '--tags'], '/$bunfs/root/gp-other')).toEqual(['--tags'])
    expect(scriptArgs(['--tags'], undefined, SCRIPT)).toEqual(['--tags'])
    expect(scriptArgs(['x'], ['bun', SCRIPT, '--', 'y'], SCRIPT)).toEqual(['x'])
  })

  test('this process reads its own command line', () => {
    expect(scriptArgs()).toEqual(process.argv.slice(2))
  })

  // A bin on PATH is a link to the script, which Bun resolves for process.argv[1] while the command line keeps the link. The shebang names bun itself, busybox env (CI's alpine) having no -S.
  test.each([['by its path', false], ['through a link on PATH', true]])('a script run %s gets its -- back', (_, linked) => {
    const dir = temp()
    const script = join(dir, 'pkg', 'show.ts')

    mkdirSync(join(dir, 'pkg'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(script, `#!${process.execPath} --no-env-file\nimport { scriptArgs } from ${JSON.stringify(new URL('../src/argv.ts', import.meta.url).pathname)}\nconsole.log(JSON.stringify(scriptArgs()))\n`)
    chmodSync(script, 0o755)
    symlinkSync(script, join(dir, 'bin', 'show'))

    const argv = linked ? ['show', '--', '--tags'] : [process.execPath, script, '--', '--tags']
    const ran = Bun.spawnSync(argv, { env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' })

    expect(ran.stderr.toString()).toBe('')
    expect(JSON.parse(ran.stdout.toString())).toEqual(['--', '--tags'])
  })
})
