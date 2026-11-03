import { shellQuote } from '@kaynooo/cli-kit/shell'
import { displayed } from './state'

export const PREVIEW_BYTES = 64 * 1024
export const PREVIEW_LINES = 200
const PREVIEW_TIMEOUT_MS = 3000

/** The command with every `{}` replaced by the line, quoted for the shell. */
export function previewCommand(template: string, line: string): string {
  return template.split('{}').join(shellQuote(line))
}

/** What a preview command printed, as the lines drawn: escapes out, at most `PREVIEW_LINES` of them. */
export function previewLines(output: string): string[] {
  const lines = output.split('\n')

  if (lines.at(-1) === '')
    lines.pop()

  return lines.slice(0, PREVIEW_LINES).map(displayed)
}

/** Runs the preview in a shell with its errors merged into its output, stopping at `PREVIEW_BYTES`, after a few seconds or when `signal` aborts. */
export async function runPreview(template: string, line: string, signal: AbortSignal): Promise<string[]> {
  const proc = Bun.spawn(['sh', '-c', `exec 2>&1\n${previewCommand(template, line)}`], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const stop = (): void => proc.kill()
  const timer = setTimeout(stop, PREVIEW_TIMEOUT_MS)
  const chunks: Uint8Array[] = []
  let size = 0

  signal.addEventListener('abort', stop)

  try {
    for await (const chunk of proc.stdout) {
      chunks.push(chunk)
      size += chunk.length

      if (size >= PREVIEW_BYTES) {
        stop()

        break
      }
    }
  }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }

  return signal.aborted ? [] : previewLines(Buffer.concat(chunks).subarray(0, PREVIEW_BYTES).toString())
}
