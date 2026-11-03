# @kaynooo/cli-pick

`pick` is a fuzzy selector in the colours of the other @kaynooo CLIs: lines on stdin, the chosen one on stdout.

```sh
bun add -g @kaynooo/cli-pick
```

| Command | What it does |
| --- | --- |
| `git branch --format='%(refname:short)' \| pick` | filters the lines as you type and prints the one you pick |
| `ls \| pick --multi` | tab marks lines, enter prints the marked ones (the highlighted one when none is marked) |
| `pick --prompt 'branch> ' --query main` | a custom prompt, a query to start with |
| `ls \| pick --preview 'head -20 {}'` | a pane on the right (terminal at least 80 columns) shows the command run for the highlighted line, `{}` shell-quoted |
| `--height 12`, `--height 60%` | lines or a share of the terminal to draw in (40%) |

Keys: type to filter, up and down or ctrl-p and ctrl-n to move, enter to pick, esc or ctrl-c to cancel (exit 1, nothing printed), ctrl-u clears the query, ctrl-w deletes a word.

The query matches as a subsequence, best first: a word start, a run of consecutive characters or a prefix scores higher, a lowercase query ignores case and an uppercase letter makes it exact. Keys come from `/dev/tty` and the selector is drawn on stderr, so a pipe or a command substitution takes only the choice. Without a terminal on stderr it exits 2.

Not a replacement for fzf where its other features are used (`--expect`, `--print-query`, `--bind` reloads, `--with-nth`): see [#127](https://git.kaynooo.fr/kaynooo/cli/issues/127).
