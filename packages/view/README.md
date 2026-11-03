# @kaynooo/cli-view

`view` shows a markdown file or a git diff in the colours of the other @kaynooo CLIs: the kit roles, wrapped to the terminal, paged through `less -FRX` when it is long.

```sh
bun add -g @kaynooo/cli-view
```

| Command | What it does |
| --- | --- |
| `view README.md` | headings with their `#` marks, emphasis, lists with bullets by depth, numbers and task boxes, quotes and code blocks behind a bar, tables with wrapped cells, links as OSC 8 links |
| `git diff \| view` | file headers, hunk ranges, added and removed lines coloured; a `git log -p` or `git show` too |
| `view --diff`, `--markdown` | force the reading when the first line or the file name does not say |
| `--width <n>`, `--no-pager` | wrap to a width instead of the terminal's, never page |

The text is a file, or what is piped on stdin. A diff is recognised by its first line (`diff --git`, `--- `, `@@`, `commit <sha>`) or a `.diff` or `.patch` name; anything else is markdown. With `NO_COLOR`, a pipe or `--plain` it prints without colour: links as `text (url)`, images as `[image: alt]`.

Not in v1: word-level diff highlighting and syntax highlighting of code blocks.
