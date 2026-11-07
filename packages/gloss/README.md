# @kaynooo/cli-gloss

`gloss` explains a shell command line in the terminal, the way explainshell does in a browser: each option is matched to what the man page on this machine says about it. It reads no network and runs nothing of what it explains.

```sh
bun add -g @kaynooo/cli-gloss
```

| Command | What it does |
| --- | --- |
| `gloss 'tar -xzvf a.tgz -C /tmp'` | the command, then one row per option with its description, and the value each option takes |
| `gloss -- git commit -am fix` | the words after `--` are the command line, so no quoting is needed |
| `echo 'ls -la \| wc -l' \| gloss` | without arguments the command line is read from stdin |
| `gloss --run-help 'rg -i foo'` | for a command with no man page, runs `rg --help` and reads its options. It runs the command, so only for ones you trust: a bare name found on `PATH`, no stdin, 3 seconds |
| `gloss --json 'grep -in foo file'` | `{line, commands: [{name, page, summary, notes, redirects, substitutions, next}]}` |

Pipes, `&&`, `||`, `;` and `&` split the line into commands and say what joins them. Redirects (`> out`, `2>&1`), leading variable assignments and `$(...)` substitutions are explained too, a substitution as a block of its own under the word that holds it.

## How a word is matched

- The page comes from the man path (`MANPATH`, `/usr/share/man`, `/usr/local/share/man`, `~/.local/share/man`), sections 1, 8 and 6, and is rendered with `nroff`. `git commit` reads `git-commit`.
- Option entries are the indented `-x, --long=ARG` lines of the page with the text under them.
- `-xzvf` is read as bundled flags, `-fFILE` and `--file=FILE` as an option with its value, a value-taking option without one takes the next word, a unique prefix of a long option is accepted, and `--` ends the options. A single-dash long option such as `find -name` is tried whole before it is split.
- A flag the page does not list is marked as not in the man page; a command with no page is listed with its words unexplained.

Pages compressed with bz2 or xz are skipped, and old-style options without a dash (`tar xvf`) are read as arguments.
