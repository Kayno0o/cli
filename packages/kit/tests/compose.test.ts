import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { compose, composeError, jsonLines } from '../src'
import { tempDirs } from '../src/test'

const temp = tempDirs()

// A `docker` on the PATH that prints its arguments, its working directory and COMPOSE_FILE, and exits with the code in FAKE_EXIT.
function fakeDocker(): Record<string, string> {
  const bin = temp('compose-bin-')
  const script = join(bin, 'docker')

  writeFileSync(script, '#!/bin/sh\necho "args:$*"\necho "cwd:$PWD"\necho "file:$COMPOSE_FILE"\necho "boom" >&2\necho "last line" >&2\nexit "$FAKE_EXIT"\n')
  chmodSync(script, 0o755)

  return { PATH: `${bin}:${process.env.PATH}` }
}

describe('compose', () => {
  test('runs docker compose with the flags before the arguments, and returns both streams', async () => {
    const result = await compose(['config', '--format', 'json'], { flags: ['-f', 'a.yaml'], env: { ...fakeDocker(), FAKE_EXIT: '0' } })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('args:compose -f a.yaml config --format json')
    expect(result.stderr).toBe('boom\nlast line\n')
  })

  test('runs in the folder given and with the environment given', async () => {
    const cwd = temp('compose-cwd-')
    const result = await compose(['ps'], { cwd, env: { ...fakeDocker(), FAKE_EXIT: '0', COMPOSE_FILE: '' } })

    expect(result.stdout).toContain(`cwd:${cwd}`)
    expect(result.stdout).toContain('file:\n')
  })

  test('returns a failing exit code instead of throwing', async () => {
    expect((await compose(['ps'], { env: { ...fakeDocker(), FAKE_EXIT: '3' } })).code).toBe(3)
  })

  test('throws when docker cannot start', async () => {
    let error: unknown

    try {
      await compose(['ps'], { env: { PATH: temp('compose-empty-') } })
    }
    catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
  })
})

describe('composeError', () => {
  test('is the last line compose wrote, else the exit code', () => {
    expect(composeError({ code: 1, stdout: '', stderr: 'first\nno such service\n' })).toBe('no such service')
    expect(composeError({ code: 14, stdout: '', stderr: '\n' })).toBe('exit 14')
  })
})

describe('jsonLines', () => {
  test('reads one object per line, or the array older compose printed', () => {
    expect(jsonLines<{ ID: string }>('{"ID":"a"}\n{"ID":"b"}\n').map(row => row.ID)).toEqual(['a', 'b'])
    expect(jsonLines<{ ID: string }>('[{"ID":"a"}]').map(row => row.ID)).toEqual(['a'])
    expect(jsonLines('\n')).toEqual([])
  })
})
