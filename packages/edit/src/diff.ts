import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fail } from '@kaynooo/cli-kit'

export interface Diff {
  unified: string
  added: number
  removed: number
}

// The unified diff of a file's two versions, through the system's diff.
export async function diffTexts(path: string, before: string, after: string): Promise<Diff> {
  const dir = mkdtempSync(join(tmpdir(), 'sub-'))

  try {
    writeFileSync(join(dir, 'before'), before)
    writeFileSync(join(dir, 'after'), after)

    let child

    try {
      child = Bun.spawn(['diff', '-u', '--label', `a/${path}`, '--label', `b/${path}`, join(dir, 'before'), join(dir, 'after')], { stdout: 'pipe', stderr: 'pipe' })
    }
    catch {
      fail('diff is not installed, which sub needs to show its changes', 1)
    }

    const unified = await new Response(child.stdout).text()

    await child.exited

    const lines = unified.split('\n')

    return {
      unified,
      added: lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length,
      removed: lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length,
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
