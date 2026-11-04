export interface ComposeOptions {
  // Compose's own options, given before the subcommand: `['-f', 'compose.yaml']`, `['-p', project]`, `['--project-directory', dir]`.
  flags?: string[]
  cwd?: string
  // Variables set over the process's environment for compose.
  env?: Record<string, string | undefined>
}

export interface CommandOutput {
  code: number
  stdout: string
  stderr: string
}

// Runs a command to its end with no stdin and returns both streams apart, whatever its exit code; it throws when the command cannot start.
export async function captureOutput(argv: string[], { cwd, env }: Pick<ComposeOptions, 'cwd' | 'env'> = {}): Promise<CommandOutput> {
  const run = Bun.spawn(argv, { ...cwd === undefined ? {} : { cwd }, env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([run.stdout.text(), run.stderr.text(), run.exited])

  return { code, stdout, stderr }
}

// Runs `docker compose <flags> <args>` to its end: `captureOutput` with compose in front.
export async function compose(args: string[], { flags = [], ...options }: ComposeOptions = {}): Promise<CommandOutput> {
  return captureOutput(['docker', 'compose', ...flags, ...args], options)
}

// Why a command failed, in its own words: the last line it wrote to stderr, else `exit <code>`.
export function composeError({ code, stderr }: CommandOutput): string {
  const last = stderr.trim().split('\n').at(-1) ?? ''

  return last === '' ? `exit ${code}` : last
}

// The objects of `docker compose ps --format json`, which prints one per line since Compose 2.21 and an array before.
export function jsonLines<T>(text: string): T[] {
  const trimmed = text.trim()

  if (trimmed === '')
    return []

  return trimmed.startsWith('[') ? JSON.parse(trimmed) as T[] : trimmed.split('\n').map(line => JSON.parse(line) as T)
}
