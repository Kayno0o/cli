import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { git } from '../src/git'

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return ''
}

describe('git', () => {
  test('names a removed working directory instead of "No such file or directory"', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'gl-cwd-')))
    const home = process.cwd()

    try {
      process.chdir(dir)
      await rm(dir, { recursive: true })
      expect(await refusal(git(['status']))).toContain('the working directory was removed')
    }
    finally {
      process.chdir(home)
    }
  })

  test('names a git binary that is not installed', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'gl-nogit-'))
    const saved = process.env.PATH

    try {
      process.env.PATH = empty
      expect(await refusal(git(['status']))).toStartWith('git status: ')
    }
    finally {
      process.env.PATH = saved
      await rm(empty, { recursive: true, force: true })
    }
  })
})
