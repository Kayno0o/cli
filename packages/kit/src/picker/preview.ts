import process from 'node:process'
import { shellQuote } from '../shell'

export const PREVIEW_BYTES = 64 * 1024
export const PREVIEW_LINES = 200
const PREVIEW_TIMEOUT_MS = 3000

const PLACEHOLDER = /\{([1-9]\d*)?\}/g

/** The command with `{}` replaced by the line and `{1}`, `{2}`... by the hidden fields, each quoted for the shell. */
export function previewCommand(template: string, line: string, hidden: readonly string[] = []): string {
  return template.replace(PLACEHOLDER, (_, field?: string) => shellQuote(field === undefined ? line : hidden[Number(field) - 1] ?? ''))
}

/** What a preview command printed, as the lines drawn, style escapes included: at most `PREVIEW_LINES` of them. */
export function previewLines(output: string): string[] {
  const lines = output.split('\n')

  if (lines.at(-1) === '')
    lines.pop()

  return lines.slice(0, PREVIEW_LINES)
}

/** Runs the preview in a shell with its errors merged into its output, stopping at `PREVIEW_BYTES`, after a few seconds or when `signal` aborts. */
export async function runPreview(template: string, line: string, signal: AbortSignal, hidden: readonly string[] = []): Promise<string[]> {
  const proc = Bun.spawn(['sh', '-c', `exec 2>&1\n${previewCommand(template, line, hidden)}`], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', detached: true })
  // The shell leads its own process group, so the kill reaches what it started too, which would otherwise keep the output open.
  const stop = (): void => {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    }
    catch {
      proc.kill()
    }
  }
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
