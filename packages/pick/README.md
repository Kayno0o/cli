# @kaynooo/cli-pick

`pick` is a fuzzy selector in the colours of the other @kaynooo CLIs: lines on stdin, the chosen one on stdout. It is for a person at a terminal, not for a Claude Code session, which has no terminal to answer it; without a terminal on stderr it prints the first line containing `--query` (case-insensitive, every one with `--multi`) and exits 1 when none does.

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

Keys: type to filter, up and down or ctrl-p and ctrl-n to move, enter to pick, esc or ctrl-c to cancel (exit 1, nothing printed), ctrl-u clears the query, ctrl-w deletes a word, ctrl-/ or f1 opens a legend of the keys until the next key. The count line ends in a `ctrl-/ keys` hint, and the characters a query matched are underlined.

The query matches as a subsequence, best first: a word start, a run of consecutive characters or a prefix scores higher, a lowercase query ignores case and an uppercase letter makes it exact. Keys come from `/dev/tty` and the selector is drawn on stderr, so a pipe or a command substitution takes only the choice. Without a terminal on stderr it exits 2.

The same picker is what `gb`, `dx`, `sf` and `j` use, with `--expect` keys, the query back, hidden fields and reloads: its engine is `@kaynooo/cli-kit/picker`, so none of them needs fzf.
