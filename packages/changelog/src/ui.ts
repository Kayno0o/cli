import { paint } from '@kaynooo/cli-kit'

// Read per call: the colour flags are applied to the environment once the arguments are parsed.
export const out = () => paint(process.stdout)
export const err = () => paint(process.stderr)

// Under --json stdout carries the result alone, so what the commands and the libraries log goes to stderr while `body` runs.
export async function stdoutToStderr<T>(active: boolean, body: () => Promise<T>): Promise<T> {
  const log = console.log

  if (active)
    console.log = (...args: unknown[]) => console.error(...args.length === 0 ? [''] : args)

  try {
    return await body()
  }
  finally {
    console.log = log
  }
}
