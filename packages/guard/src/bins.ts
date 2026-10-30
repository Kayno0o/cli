// What each agent-tools bin is for, as the prompt lists the installed ones; the zshrc agent-tools mod carries a copy, kept in step by hand until zshrc#111.
export const BINS: Record<string, string> = {
  check: '`check`: runs the repo\'s check, typecheck, lint and test steps and prints only what failed, each full log saved to a file; validate a change with it rather than chaining the scripts (`--only lint,test`, `--list`).',
  fix: '`fix`: runs the repo\'s fixers and formatters (its fix, lint:fix and format scripts, just fmt, go fmt, cargo fmt, ruff) and lists the files they changed.',
  db: '`db "<sql>"`: one read-only statement against the Postgres in DATABASE_URL (`-e KEY` for another) or, without one, the compose project\'s running Postgres service (`-s <service>`, `-d <database>`), credentials never shown, a write printed for the user to run; `db tables`, `db describe <table>`, `db dbs`.',
  ev: '`ev`: .env files read and edited with values masked (`ev list`, `ev get KEY`, `ev grep <regex>`, `ev show <rev>:<file>`, `ev set`, `ev diff`, `ev missing`); `ev audit [dir]` finds env files others can read or git tracks, and compose files writing secrets out.',
  redact: '`redact`: masks secrets in piped output, `<cmd> | redact`.',
  pkg: '`pkg <name>[@version]`: checks an npm package before it is added: whether the name exists or is a near miss of a popular one, the newest version at least two weeks old, licence, install scripts; `bun add`, `npm install`, `pnpm add` and `yarn add` run it first and are refused on what it flags.',
  stack: '`stack port <name>`: the port a service name always hashes to, for every host port a compose file publishes; `stack audit [dir]` cross-checks release.config.ts against its compose files.',
  ft: '`ft`: Forgejo CI runs, logs and waits, releases, issue checklists and claims, in a repo whose origin is on Forgejo.',
  sub: '`sub --from <text> --to <text> <file>...`: replaces text, writing nothing unless each match count is as expected (1, `-n N`, `--all`), `--regex`, `--pairs <json|->` for several in order, `--dry-run --diff`; use it instead of sed -i, a bun -e or python editor.',
  base: '`base [--ref <rev>] [--keep <path>...] -- <cmd>`: runs a command at HEAD (or a ref) in a temporary worktree, removed afterwards, ignored env files and node_modules/vendor linked; use it instead of git stash to see whether a test fails without your change (`--keep` the new test).',
  gst: '`gst [--log N]`: branch, upstream, changed counts and HEAD in one line, then the changed paths by staged, unstaged and untracked; use it instead of `git status --short` and `git log --oneline`.',
  gc: '`gc <title> [-m <line>]... [--ticket <line>]... -- <path>...`: commits exactly those paths, refusing with nothing staged when the message breaks a commit rule, a path has no change or other files are already staged; use it instead of chaining git add, status and commit.',
  waitfor: '`waitfor --file <log> --until <regex> [--fail <regex>]`, `--port <n>`, `--url <url>` (`-t 5m`): waits until the line shows, the port listens or the URL answers 2xx, exits 1 on a --fail line with the lines around it, 2 on a timeout with the last lines; use it instead of sleep and tail or polling loops.',
  gl: '`gl ci [ref]` waits for the GitLab pipeline covering a commit and prints each failed job\'s tests (exit 0/1/2), `gl runs`, `gl logs <pipeline> [-j job] [--full]`; use it instead of `glab ci` or `glab api .../pipelines/<id>/jobs` polled in a sleep loop.',
  out: '`out -- <cmd>`: folds long output, keeping the errors and saving the full log; run noisy builds, installs, tests and linters through it.',
}

export function binsSection(installed: Set<string>): string | undefined {
  const lines = Object.entries(BINS).filter(([bin]) => installed.has(bin)).map(([, line]) => `- ${line}`)

  return lines.length === 0 ? undefined : `# Agent tools\n\nCLIs installed on this machine for you to use over hand-rolled equivalents, \`<bin> --help\` for the options:\n${lines.join('\n')}`
}
