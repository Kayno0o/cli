export { ABOUT, TOOLS } from './generated-catalog'

export interface Need {
  bin: string
  // What goes wrong without it, in the words of "<package> needs <bin>: <why>".
  why: string
  // Where to get it: doctor never installs a system package.
  how: string
  // Another binary that does the same job, so the need is met when it is installed instead.
  alternative?: string
}

// The package whose bins the Claude Code hooks call.
export const HOOKS_REQUIRES = '@kaynooo/cli-guard'

// What a package needs on the machine besides Bun.
export const NEEDS: Record<string, Need[]> = {
  '@kaynooo/cli-docker': [{ bin: 'docker', why: 'dc runs docker compose', how: 'https://docs.docker.com/engine/install/' }],
  '@kaynooo/cli-wt': [{ bin: 'git', why: 'wt manages git worktrees', how: 'https://git-scm.com/' }, { bin: 'docker', why: 'wt runs compose stacks when a project has compose.yml', how: 'https://docs.docker.com/engine/install/' }, { bin: 'mkcert', why: 'wt makes the certificates of a manifest\'s passthrough routes with it', how: 'https://github.com/FiloSottile/mkcert' }],
}
