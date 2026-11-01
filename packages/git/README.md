# gst and gc

Git for Claude Code, where a session would otherwise chain `git status --short` and `git log --oneline` to read the state, or `git add <paths> && git status && git commit -m ...` to commit and have the commit bounced over its message.

```sh
bun install -g @kaynooo/git-tools
gst --log 3
gc 'fix(band): keep it visible' -m 'The band stays above a long prompt.' --ticket '#5 - deliver every pointer' -- src/band.ts tests/band.test.ts
```

## gst

Prints one line with the branch, its upstream and how far ahead and behind it is as of the last fetch, the counts of changed, untracked and conflicted files and HEAD, then the paths grouped as `staged`, `unstaged`, `untracked` and `conflicted`, each with git's letter (`M`, `A`, `D`, `R old -> new`). `--log N` adds the last N commits as `<sha7> <title>`. `--json` prints the same as `{branch, oid, upstream, ahead, behind, head, staged, unstaged, untracked, conflicted, commits}`, a change as `{status, path, from?}`. It takes no index lock, so it runs beside another git command. Exit codes: 0, 1 outside a repository, 2 a usage error.

## gc

`gc <title> [-m <line>]... [--ticket <line>]... -- <path>...` commits exactly the paths given and prints `<sha7> <title>` then each file committed with its letter.

- The message is the title, then the `-m` lines, then the `--ticket` lines, each block after a blank line; ticket lines are copied verbatim and read `#<n> - <title>`.
- Before anything is staged it refuses, exit 1, saying which rule broke: a title that is no Conventional Commit, a title over one line, more than two description lines, a bullet list, a hard-wrapped sentence, any trailer (`Co-Authored-By`, `Signed-off-by`, "Generated with"). A breaking change (`feat!:` or a `BREAKING CHANGE:` line) may give full details.
- It also refuses, with nothing staged, a path with no change (unchanged, ignored or missing) and an index already holding files beyond the given paths, which the commit would carry along.
- A path may be a directory or a deleted file. When git refuses the commit (a hook), the paths are unstaged again and git's output is shown.
- Exit codes: 0 committed, 1 refused, 2 a usage error.

## Library

`@kaynooo/git-tools/message` exports `commitMessageViolation(message)`, the rule a message breaks as the sentence to show or null, and the rule sentences, for the guard that checks a `git commit` typed by hand.
