export interface Rule {
  name: string
  // What the rule refuses.
  refuses: string
  // The route its refusal points at.
  route: string
  // Where it runs: both `guard check` and `guard hook`, or the hook alone.
  runs: 'check and hook' | 'hook'
}

// Every rule `guard check` and `guard hook` apply, in the order a verdict lists them; the names are the ones a violation carries.
const LISTED: (Omit<Rule, 'runs'> & { runs?: Rule['runs'] })[] = [
  { name: 'remote', refuses: 'ssh, scp, rsync and deploys to a remote machine', route: 'hand the command to the user' },
  { name: 'git', refuses: 'stash, whole-tree add and commit, push without being asked, tags', route: 'stage by path with `gc`, push only when asked' },
  { name: 'destructive', refuses: 'reset --hard, discarding the tree, clean -f, force push, branch -D, rebase, filter-branch, rm -r on a broad path, curl piped to a shell, dl --exec --yes on an unpinned script', route: 'commit with `gc` first, `base`, `git worktree add`, `--force-with-lease` only when asked, `dl <url>` then `dl <url> --exec --sha256 <sha>`' },
  { name: 'commit', refuses: 'a commit message breaking the format, an unreadable one, trailers', route: '`gc <title> -m <line> -- <path>...`' },
  { name: 'sql', refuses: 'SQL writes and DDL, a file the client cannot read', route: '`db "<sql>"`, writes on a `*_test` database or handed over' },
  { name: 'env', refuses: 'reading or printing an env file, a diff of a tracked one', route: '`ev`, and `rg` for a tree-wide search' },
  { name: 'edit', refuses: 'sed -i and replace scripts', route: '`sub` (only while `sub` is installed)' },
  { name: 'package-manager', refuses: 'a manager other than the repo\'s lockfile pins', route: 'the pinned manager, rewritten by `guard check`, named by `guard hook`' },
  { name: 'pkg', refuses: 'an install `pkg check` refuses or cannot check', route: '`pkg <name>` before adding it', runs: 'hook' },
]

export const RULES: Rule[] = LISTED.map(rule => ({ runs: 'check and hook', ...rule }))
