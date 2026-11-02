import { runCommand } from '@kaynooo/cli-kit'

export interface Output {
  code: number
  stdout: string
  stderr: string
}

// Runs git without the optional index lock a read would take, and core.quotePath off so non-ASCII paths print as they are.
export async function git(args: string[], env?: Record<string, string | undefined>): Promise<Output> {
  const ran = await runCommand(['git', '--no-optional-locks', '-c', 'core.quotePath=false', ...args], env === undefined ? {} : { env })
  const text = (stream: 'stdout' | 'stderr') => Buffer.concat(ran.chunks.filter(chunk => chunk.stream === stream).map(chunk => chunk.data)).toString()

  return { code: ran.code, stdout: text('stdout'), stderr: text('stderr') }
}
