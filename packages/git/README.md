# gst, gc and gb

Git for Claude Code, where a session would otherwise chain `git status --short` and `git log --oneline` to read the state, or `git add <paths> && git status && git commit -m ...` to commit and have the commit bounced over its message.

```sh
bun install -g @kaynooo/cli-git
gst --log 3
gc 'fix(band): keep it visible' -m 'The band stays above a long prompt.' --ticket '#5 - deliver every pointer' -- src/band.ts tests/band.test.ts
```

## gst

Prints one line with the branch, its upstream and how far ahead and behind it is as of the last fetch, the counts of changed, untracked and conflicted files and HEAD, then the paths grouped as `staged`, `unstaged`, `untracked` and `conflicted`, each with git's letter (`M`, `A`, `D`, `R old -> new`). `--log N` adds the last N commits as `<sha7> <title>`. `--json` prints the same as `{branch, oid, upstream, ahead, behind, head, staged, unstaged, untracked, conflicted, commits}`, a change as `{status, path, from?}`. It takes no index lock, so it runs beside another git command. Exit codes: 0, 2 outside a repository or a usage error.

## gc

`gc <title> [-m <line>]... [--ticket <line>]... -- <path>...` commits exactly the paths given and prints `<sha7> <title>` then each file committed with its letter; `--json` prints `{sha, subject, files: [{status, path, from?}]}`.

- The message is the title, then the `-m` lines, then the `--ticket` lines, each block after a blank line; ticket lines are copied verbatim and read `#<n> - <title>`.
- Before anything is staged it refuses, exit 1, saying which rule broke: a title that is no Conventional Commit, a title over one line, more than two description lines, a bullet list, a hard-wrapped sentence, any trailer (`Co-Authored-By`, `Signed-off-by`, "Generated with"). A breaking change (`feat!:` or a `BREAKING CHANGE:` line) may give full details.
- It also refuses, with nothing staged, a path with no change (unchanged, ignored or missing) and an index already holding files beyond the given paths, which the commit would carry along.
- A path may be a directory or a deleted file. When git refuses the commit (a hook), the paths are unstaged again and git's output is shown.
- Exit codes: 0 committed, 1 refused, 2 a usage error or outside a git repository.

## gb

`gb [branch]` picks a git branch and switches to it: the branches last checked out first (from the reflog), then the other local ones, then the remote ones with no local branch yet. The header says where HEAD stands, each row how its branch stands against its upstream and whether it is merged into the base. Keys: enter switches (a remote branch gets its tracking branch), ctrl-n creates a branch named after the query, ctrl-d deletes the highlighted local branch with `git branch -d`, ctrl-r fetches and prunes. Without a terminal it lists the branches, as JSON with `--json`.

- `gb <branch>` switches without the picker, a bare name finding the remote branch it would create; `gb -` goes back, `gb -c <name>` creates a branch, `gb -d <branch>` deletes a local one.
- A branch checked out in another worktree needs a `cd`, which a command cannot do for its shell: `gb` prints the worktree's path on stdout and a hint on stderr.
- Hidden flags for wrappers: `--emit` (with any of the above) prints the command as lines for a shell function to run, `--list` the rows as JSON for term, `--names` the branches with their last commit for shell completions, `--show <branch>` the preview and `--fetch` what ctrl-r runs.
- Exit codes: the git command's, 1 when no branch is picked or found, 2 outside a repository.

## Library

`@kaynooo/cli-git/message` exports `commitMessageViolation(message)`, the rule a message breaks as the sentence to show or null, and the rule sentences, for the guard that checks a `git commit` typed by hand.
