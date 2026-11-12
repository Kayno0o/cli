# gst, gc, gb, gp, gf, gm, gcl, gd and gu

Git for Claude Code, where a session would otherwise chain `git status --short` and `git log --oneline` to read the state, or `git add <paths> && git status && git commit -m ...` to commit and have the commit bounced over its message.

```sh
bun install -g @kaynooo/cli-git
gst -n 3
gc 'fix(band): keep it visible' -m 'The band stays above a long prompt.' --ticket '#5 - deliver every pointer' -- src/band.ts tests/band.test.ts
```

## gst

Prints one line with the branch, its upstream and how far ahead and behind it is as of the last fetch, the counts of changed, untracked and conflicted files and HEAD, then the paths grouped as `staged`, `unstaged`, `untracked` and `conflicted`, each with git's letter (`M`, `A`, `D`, `R old -> new`). `-n N` (`--limit`, and the former `--log` and `-l`) adds the last N commits as `<sha7> <title>`. `--json` prints the same as `{branch, oid, upstream, ahead, behind, head, staged, unstaged, untracked, conflicted, commits}`, a change as `{status, path, from?}`. It takes no index lock, so it runs beside another git command. Exit codes: 0, 2 outside a repository or a usage error.

`gst --repos [dir]...` (`-r`) lists every repository at and below the current one's toplevel, or below each dir given (the current directory outside a repository): a folder holding `.git` is one, four levels down, `node_modules`, `vendor`, `dist` and hidden folders never walked into, symlinks never followed. One line each: its path from the current directory, branch, how it stands against its upstream as of the last fetch (`2 ahead, 1 behind`, `up to date`, `no upstream`, `upstream gone`) and the files left to commit (`3 changed, 1 untracked` or `clean`). `--json` prints an array of the objects above, each with its `path` and no `commits`, a repository git cannot read being `{path, error}`.

## gp

`gp [dir]...` pushes the current branch of the repository, or of each dir's, when it is ahead of its upstream as of the last fetch, and with `-u` to origin (the only remote when there is no origin) when it has no upstream yet. `--repos` (`-r`) pushes every repository `gst --repos` lists, one after another.

- A detached HEAD, a branch with nothing ahead and a repository with no remote are skipped, saying so; a refused push shows git's reason and the next repository is still pushed.
- What follows `--` goes to each `git push` (`gp -- --tags`, `gp -- --force-with-lease`), and a branch with nothing ahead is then pushed too.
- `--dry-run` says what would be pushed; `--json` prints `{path, branch, remote, commits, outcome, reason?}` per repository, `outcome` being `pushed`, `would-push`, `skipped` or `refused`.
- Exit codes: 0 every push went through or there was nothing to push, 1 a push was refused or a repository could not be read, 2 outside a repository or a usage error.

## gc

`gc <title> [-m <line>]... [--ticket <line>]... -- <path>...` commits exactly the paths given and prints `<sha7> <title>` then each file committed with its letter, nothing with `-q`/`--quiet`; `--json` prints `{sha, subject, files: [{status, path, from?}]}`.

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

## gf

`gf [dir]...` fetches with prune, then fast-forwards the current branch onto its upstream, and prints what came in (`main <- origin/main, 2 commits`). `--repos` (`-r`) does every repository `gst --repos` lists; `--no-pull` fetches only and says how far behind the branch is.

- It never merges or rebases: a branch that has diverged, or a working tree the fast-forward would overwrite, is refused and left as it was, with git's reason.
- A detached HEAD, a branch with no upstream and one whose upstream is gone are fetched only, saying so.
- `--json` prints `{path, branch, upstream, commits, outcome, reason?}` per repository, `outcome` being `updated`, `current`, `fetched`, `skipped` or `refused`.
- Exit codes: 0 every repository was fetched, and fast-forwarded when it could be, 1 a fetch failed, a branch diverged or a fast-forward was refused, 2 outside a repository or a usage error.

## gm

`gm <branch>` merges the branch into the current one with `git merge --no-edit` and prints what came in: fast-forward or merge commit, the commits and the files changed. Staged changes are refused, and so are unstaged ones in files the merge changes; other unstaged edits stay as they are, through a conflict and gm --abort too.

- On a conflict every conflicted file is listed with its conflict regions (the markers and two lines around them, line numbers included) and the exit is 1; `gm --continue` stages the conflicted files and commits once the markers are gone, refusing while one remains or while a file git could not mark (binary, deleted on one side, `merge=binary`) is still not added or removed, and `gm --abort` gives the merge up.
- `gm --dry-run <branch>` says whether the merge would conflict, and in which files, with `git merge-tree` and nothing touched.
- `--squash` stages the branch's changes without committing them or recording a merge, to commit with `gc`; a conflict then leaves the files to resolve and `git reset --merge` gives up.
- With no branch, a terminal gets a picker of the other branches (ahead and behind the current one, a preview of the commits, files and verdict; enter merges, ctrl-s squashes); without a terminal the branches are listed with their verdict, `--json` giving `[{name, ahead, behind, outcome, conflicts}]`.
- Exit codes: 0 merged, already merged or no conflict in a dry run, 1 a conflict, a dirty tree or a refusal, 2 outside a repository or a usage error.

## gcl

`gcl <repo> [dir]` clones into `<workspace>/<name>` (the workspace `cli config` reports) or into `dir`, and prints the path on stdout, so `cd (gcl kaynooo/cli)` lands in it. `<repo>` is a URL, an scp-style address, a local path or `owner/name`, read as `https://git.kaynooo.fr/owner/name.git`; the `forge` key of `~/.config/kaynooo-cli/config.json` names another host.

- A folder that already holds the repository is not cloned again: it is fetched and fast-forwarded as `gf` does. A folder holding anything else is refused, exit 1.
- `--json` prints `{url, path, branch, head, outcome}`, `outcome` being `cloned` or `existing`.

## gd

`gd [path]...` lists the tracked files that changed with their added and removed lines, staged apart from unstaged; untracked files are `gst`'s. With paths, or `--patch` (`-p`), it prints the patch instead, through `view --diff` on a terminal when `view` is installed.

- `--staged` (`-s`) keeps what is staged; `--ref <rev>` compares the working tree to a commit, branch or tag, and `--ref a..b` two commits.
- `--json` prints `[{title, files: [{path, added, removed}], patch?}]`, the counts being null for a binary file; with paths or `--patch` each section also holds its patch, its files narrowed to the paths.
- Exit codes: 0, 1 git refused (an unknown ref), 2 outside a repository or a usage error.

## gu

`gu <path>...` undoes changes and keeps what it takes away.

- By default it discards the unstaged changes of the paths, after saving them as a patch in the git folder (`gu/<time>.patch`); `git apply` puts them back. Without a path it is a usage error, never "everything".
- `--staged` unstages the paths, the working tree untouched.
- `--commit` undoes the last commit, its changes left staged (the commit stays in the reflog). It refuses a commit the upstream already holds, a merge and the first commit.
- Exit codes: 0, 1 a path with no change or a commit refused, 2 a usage error or outside a repository.

## Library

`@kaynooo/cli-git/message` exports `commitMessageViolation(message)`, the rule a message breaks as the sentence to show or null, and the rule sentences, for the guard that checks a `git commit` typed by hand.
