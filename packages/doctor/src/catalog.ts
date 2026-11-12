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

// One line per package, shown beside it when `doctor --install` asks which to add.
export const ABOUT: Record<string, string> = {
  '@kaynooo/cli-arc': 'pack a folder into a verified .tar.zst, deleting it only with --delete, unpack without overwriting',
  '@kaynooo/cli-base': 'run a command at a ref in a throwaway worktree, and prove a test fails before a change',
  '@kaynooo/cli-changelog': 'release notes from conventional commits, published as a Forgejo release',
  '@kaynooo/cli-check': 'the repo\'s check, lint and test steps, its fixers, error lines from logs and a recipe picker',
  '@kaynooo/cli-code': 'source read by spans, TODO comments and the files worth splitting',
  '@kaynooo/cli-db': 'read-only SQL against Postgres, MySQL and MariaDB, credentials never shown',
  '@kaynooo/cli-dev': 'passwords, JWTs, timestamps, UUIDs, base64 and file hashes',
  '@kaynooo/cli-dl': 'downloads checked by sha256, extracted, installed as commands or run as pinned scripts',
  '@kaynooo/cli-docker': 'docker compose on the stack found here, service health, shells and Symfony commands',
  '@kaynooo/cli-doctor': 'this install check, and the list of every bin',
  '@kaynooo/cli-edit': 'replace text in files, writing nothing unless every match count is right',
  '@kaynooo/cli-env': '.env files listed and edited with secrets masked, and a secrets filter for pipes',
  '@kaynooo/cli-forgejo': 'Forgejo CI runs, logs, releases and issue checklists',
  '@kaynooo/cli-git': 'repository state in one line, commits of exact paths, a branch picker',
  '@kaynooo/cli-gitlab': 'GitLab pipelines and their failed tests',
  '@kaynooo/cli-gloss': 'explains a shell command line from its man pages',
  '@kaynooo/cli-guard': 'the safety rules a Claude Code Bash call is held to',
  '@kaynooo/cli-out': 'shortens a noisy command\'s output, keeping the errors',
  '@kaynooo/cli-pick': 'a fuzzy selector for pipes',
  '@kaynooo/cli-pkg': 'vets npm packages before they are added, and bumps a lib in its consumers',
  '@kaynooo/cli-probe': 'a site\'s HTTP version, redirects, timings and TLS',
  '@kaynooo/cli-proc': 'what a process is, who listens on a port, leftover dev processes',
  '@kaynooo/cli-stack': 'a stable port per service name, and a compose release audit',
  '@kaynooo/cli-view': 'markdown, source and git diffs in the colours of the other bins',
  '@kaynooo/cli-wait': 'wait for a line, a port, a URL or a process; a machine-wide slot for heavy jobs',
  '@kaynooo/cli-workspace': 'the repositories under a root needing attention, reclaimable folders and known vulnerabilities',
  '@kaynooo/cli-wt': 'git worktrees of a compose project, each with its own stack, data and subdomains',
}

// What a package needs on the machine besides Bun. `tea` is checked on its own, with the login.
export const NEEDS: Record<string, Need[]> = {
  '@kaynooo/cli-forgejo': [{ bin: 'tea', why: 'ft goes through it', how: 'https://gitea.com/gitea/tea/releases, or gt (gitea-cli) instead', alternative: 'gt' }],
  '@kaynooo/cli-gitlab': [{ bin: 'glab', why: 'gl goes through it', how: 'https://gitlab.com/gitlab-org/cli' }],
  '@kaynooo/cli-docker': [{ bin: 'docker', why: 'dc, dlog, dx and sf run docker compose', how: 'https://docs.docker.com/engine/install/' }],
  '@kaynooo/cli-wt': [{ bin: 'docker', why: 'wt runs each worktree stack with docker compose', how: 'https://docs.docker.com/engine/install/' }, { bin: 'mkcert', why: 'wt makes the certificates of a manifest\'s passthrough routes with it, and nothing else needs it', how: 'https://github.com/FiloSottile/mkcert' }],
}
