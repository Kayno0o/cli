import type { Host } from './checks'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { runCommand } from '@kaynooo/cli-kit'

// Longest any command a check runs may take, since one network call stuck would hold the whole report.
const RUN_TIMEOUT_MS = 20_000

// The password database's shell, as $SHELL is the one a tool such as Claude Code runs commands in; Bun's os.userInfo().shell reads $SHELL too (oven-sh/bun#25171).
function loginShell(): string | undefined {
  if (Bun.which('getent') === null || process.getuid === undefined)
    return undefined

  const entry = Bun.spawnSync(['getent', 'passwd', String(process.getuid())]).stdout.toString().trim()

  const shell = entry.split(':')[6]

  return shell === '' ? undefined : shell
}

// The machine the bins run on; kept out of cli.ts, whose top-level run would fire inside any bundle importing it.
export function hostHere(): Host {
  const home = homedir()

  return {
    home,
    globalModules: join(process.env.BUN_INSTALL ?? join(home, '.bun'), 'install', 'global', 'node_modules'),
    bunVersion: Bun.version,
    shell: basename(loginShell() ?? process.env.SHELL ?? ''),
    which: bin => Bun.which(bin),
    run: async (argv, env) => {
      const ran = await runCommand(argv, { timeoutMs: RUN_TIMEOUT_MS, ...(env === undefined ? {} : { env: { ...process.env, ...env } }) })

      if (ran.timedOut)
        return { code: 1, stdout: '', stderr: `timed out after ${RUN_TIMEOUT_MS / 1000}s` }

      const of = (stream: 'stdout' | 'stderr') => Buffer.concat(ran.chunks.filter(chunk => chunk.stream === stream).map(chunk => chunk.data)).toString()

      return { code: ran.code, stdout: of('stdout'), stderr: of('stderr') }
    },
  }
}
