import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      throw new Error('diff is not installed, which sub needs to show its changes')
    }

    const unified = await new Response(child.stdout).text()

    await child.exited

    const body = unified.split('\n').slice(2)

    return {
      unified,
      added: body.filter(line => line.startsWith('+')).length,
      removed: body.filter(line => line.startsWith('-')).length,
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
