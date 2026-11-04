# @kaynooo/cli-view

`view` shows a markdown file or a git diff in the colours of the other @kaynooo CLIs: the kit roles, wrapped to the terminal, paged through `less -FRX` when it is long. It is for a person reading in a terminal, not for a Claude Code session, which reads files with its own tools.

```sh
bun add -g @kaynooo/cli-view
```

| Command | What it does |
| --- | --- |
| `view README.md` | headings with their `#` marks, emphasis, lists with bullets by depth, numbers and task boxes, quotes and code blocks behind a bar, tables with wrapped cells, links as OSC 8 links |
| `view src/app.ts`, `view config.yaml` | source highlighted (comments, strings, numbers, keywords, keys) behind line numbers on a terminal; ts, js, json, yaml, toml, ini, py, sh, css, html, sql, rs, go, php, java, c, rb, lua, Dockerfile, Makefile |
| `view --lang ts`, `--no-lines` | read stdin as that language; leave the line numbers off |
| `git diff \| view` | file headers, hunk ranges, added and removed lines coloured; a `git log -p` or `git show` too |
| `view --diff`, `--markdown` | force the reading when the first line or the file name does not say |
| `--width <n>`, `--no-pager` | wrap to a width instead of the terminal's, never page |

The text is a file, or what is piped on stdin. A diff is recognised by its first line (`diff --git`, `--- `, `@@`, `commit <sha>`) or a `.diff` or `.patch` name; anything else is markdown. With `NO_COLOR`, a pipe or `--plain` it prints without colour: links as `text (url)`, images as `[image: alt]`.

Code blocks in markdown are highlighted by their language too. The highlighting is a light tokenizer, not a parser: it gets comments, strings, numbers and keywords right for the common languages, and leaves a language it does not know uncoloured.

Not yet: word-level diff highlighting.
