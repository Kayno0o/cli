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

// What a package needs on the machine besides Bun. `tea` is checked on its own, with the login.
export const NEEDS: Record<string, Need[]> = {
  '@kaynooo/cli-forgejo': [{ bin: 'tea', why: 'ft goes through it', how: 'https://gitea.com/gitea/tea/releases, or gt (gitea-cli) instead', alternative: 'gt' }],
  '@kaynooo/cli-gitlab': [{ bin: 'glab', why: 'gl goes through it', how: 'https://gitlab.com/gitlab-org/cli' }],
  '@kaynooo/cli-docker': [{ bin: 'docker', why: 'dc, dlog, dx and sf run docker compose', how: 'https://docs.docker.com/engine/install/' }],
  '@kaynooo/cli-wt': [{ bin: 'docker', why: 'wt runs each worktree stack with docker compose', how: 'https://docs.docker.com/engine/install/' }, { bin: 'mkcert', why: 'wt makes the certificates of a manifest\'s passthrough routes with it, and nothing else needs it', how: 'https://github.com/FiloSottile/mkcert' }],
}
