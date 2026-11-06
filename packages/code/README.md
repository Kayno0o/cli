# peek, todo-scan and hotspots

Reads source for Claude Code in fewer calls and fewer tokens: `peek` prints the spans, declarations, usages and outlines a session would otherwise get from `sed -n N,Mp`, `grep -n` chains and whole-file reads, and `todo-scan` lists the TODO and issue-reference comments of a repository, flagging the ones whose issue is closed.

```sh
bun install -g @kaynooo/cli-code
peek src/a.ts:120-140 src/b.ts:1-40
peek --def parseCommand
peek --refs parseCommand packages/guard
peek --outline src/cli.ts README.md
peek --around 'TODO|FIXME' -C 2 src
errs -- bun check | peek
todo-scan
todo-scan --stale
hotspots --since '3 months ago' --limit 10
```

## peek

- `peek <file[:from-to]>...` prints each span under a `<file>:<from>-<to>` header, each line with its number, so an edit can target it; `<file>:<n>` is one line, a bare `<file>` the whole file. A line past 300 characters is cut.
- `--def <symbol>` prints each declaration of the symbol, the comments and decorators right above it included: a `function`, `class`, `interface`, `type`, `enum`, `const`/`let`/`var` or `namespace` (and Python's `def`/`class`, Go's `func`, Rust's `fn`/`struct`/`trait`), or a class member whose parameters follow its name. Its end is where its braces close, strings and line comments left out of the count, or for Python and YAML where its indentation ends.
- `--refs <symbol>` lists the lines naming the symbol as a whole word, grouped by file, one trimmed line each, at most 100 (`--limit <n>`, `--full` for all, the count of the rest after them). `--defs-first` prints the symbol's declarations before them (`{definitions, references}` under `--json`).
- `--def` repeats for several symbols in one call (`peek --def a --def b src`); one with no declaration is named and exits 1.
- `--outline <file>...` lists the declarations at the top of each file and the members one level inside its classes, with their line numbers; a Markdown file lists its headings.
- `--around <regex> -C <n>` prints the `n` (3) lines on each side of each matching line, spans that touch merged, at most 20 spans (`--limit`, `--full`, the count of the rest after them).
- Piped into with no file and no mode, it reads the `path:line` opening each line of the input (`errs`, `rg -n`, `grep -n`, a linter's `path:line:col`, tsc's `path(line,col)`) and prints the `-C` (3) lines around each, spans that touch merged and files in the order first named; a path outside the repository or not readable is skipped, and nothing readable exits 1.
- `--json` prints the spans as `[{path, from, to, lines}]`, `--refs` as `[{path, line, text}]` and `--outline` as `[{path, line, depth, text}]`, the lines never cut; a failure prints as `{"error"}` on stderr.
- `--def`, `--refs` and `--around` look through the paths given, the files git keeps here by default (`git ls-files` with the untracked files `.gitignore` lets through), and outside a repository a walk leaving dot folders and `node_modules`, `dist`, `build`, `vendor`, `target`, `coverage` and the names in the `ignore` array of `~/.config/kaynooo-cli/config.json` out; binary files and files over 2 MB are skipped.
- The symbols are found by pattern, not by a type checker: a name declared twice in a file shows twice, and a symbol re-exported under another name is not followed.
- A path must lie inside the repository (a symlink out of it counts as outside), absolute or relative. Exits 1 when nothing is found, a file cannot be read or a span starts past the end, 2 on a usage error or a path outside the repository.

## todo-scan

- `todo-scan [path...]` prints `<file>:<line>: <comment>` for each comment holding `TODO`, `FIXME` or an `owner/repo#N` reference, over the same files as `peek`. A comment opens with `//` (not a URL's), `/*`, `<!--`, a `#` or `--` standing alone, or the `*` of a block comment's line; in Markdown and HTML only `<!--` does.
- `--stale` looks each referenced issue up with `ft issue <n>... -r <owner/repo> --json`, one call per repository, or with `gh api` for a repository Forgejo does not have (a GitHub one), keeps the comments naming a closed issue (`src/a.ts:3: kaynooo/kayjs#823 closed: ...`) and exits 1 when it finds one; a repository neither can reach is named on stderr and makes the run exit 2 when no stale comment was found, so a clean exit never hides an unchecked issue. `ft` is needed only for a reference it can look up.
- `--json` prints `[{path, line, kind, text, refs}]`, each ref with its `state` under `--stale`.

## hotspots

- `hotspots [dir]` ranks the source files by complexity times churn, so the files both hard to read and often edited come first: rank, score, churn, recent, complexity, lines, file and the file's most complex declaration. The files are the ones git keeps (`.gitignore` honoured).
- Churn is the commits touching the file since `--since` (any date git reads, `6 months ago` by default), counted from one `git log`. The score uses `recent`, the commits weighted by age (half as much every `--half-life`, `90d` by default, `0` to count them alike), and leaves out the commits touching more than `--bulk` files (25), the format and rename sweeps. Complexity is the decision points of the file (`if`, loops, `case`, `catch`, `&&`, `||`, `??`, ternaries, `and`/`or`) plus one, counted with comments and strings blanked; it is computed in-house (js, ts, vue, svelte, astro, kay, php, py, go, rs, rb, java, kt, swift, cs, c, cpp, scala, dart, lua and shell files are ranked) so the bin needs no dependency and reads any language the same way.
- `--limit <n>` (`-n`) sets how many files are listed (20, the count of the rest after them), `--full` lists all, `--json` is never cut unless `--limit` is given. `--all` keeps test files and generated files (`dist/`, `*.d.ts`, `*.min.js`, snapshots, files whose first lines say generated), `--json` prints `[{rank, path, score, churn, recent, complexity, worst, lines}]`. The most complex declaration is found from the indentation alone (a class is opened into its methods), so it reads any language the same way.
- Exits 1 when no file has commits in the window, 2 on a usage error or outside a git repository.

`~/.config/kaynooo-cli/hotspots.json` (`$XDG_CONFIG_HOME/kaynooo-cli/` when set) changes the defaults of `hotspots`: `since` (a date as git reads it, `6 months ago`), `bulk` (25) and `limit` (20, the files listed).
