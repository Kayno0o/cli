# sub

Replaces text in files for Claude Code, where a session would otherwise retype a `sed -i`, a `bun -e` editor or a python heredoc: `sub` writes nothing unless every replacement matched as often as expected, and says where it did.

```sh
bun install -g @kaynooo/cli-edit
sub --from 'a.b(1)' --to 'a.c(2)' src/a.ts
```

Multi-line text goes in SEARCH/REPLACE blocks on stdin, from a quoted heredoc that needs no escaping:

```sh
sub src/a.php <<'EOF'
<<<<<<< SEARCH
old lines
=======
new lines
>>>>>>> REPLACE
EOF
```

## Behaviour

- `--from` is taken literally (`$`, `.`, `(` included) and must match exactly once per file; `--count N` expects N matches, `--all` replaces every match and expects at least one.
- `--to ''` deletes the match. A value starting with a dash goes as `--from=-x`.
- Several files at once (the shell's globs, or `rg -l X | xargs sub ...`): each is checked on its own, and one failing file leaves every file untouched.
- On a failure nothing is written, stderr lists each file and pair that failed, with the lines matched or, for a multiline `--from` found nowhere, the lines its first line is on (usually an indentation mismatch), and the exit code is 1.
- `--json` prints `{dryRun, files: [{path, replacements, lines, added, removed, diff?}]}` (`diff` under `--diff`), and on a failure `{error, failures: [{path, problem}]}` on stderr.
- `--regex` makes `--from` a regular expression (`^` and `$` match each line), `--to` taking `$1` and `$<name>`, or `${1}` and `${name}` when digits or letters follow the reference.
- Without `--from`, `--to` or `--pairs`, `sub` reads SEARCH/REPLACE blocks on stdin and applies them in order, each on the previous one's result, all or nothing, each checked like a `--from` (once, or as `--count`/`--all` say; `--regex` makes every SEARCH a regular expression). The text between the markers is taken as is, joined by newlines with none after the last line, so a SEARCH ending in a line break takes an empty line before `=======`. An empty REPLACE deletes the SEARCH text; to drop whole lines, put the neighbouring line in both.
- A line naming a file before a block makes it apply to that file alone, so one call edits several files and needs no file argument; a block without one applies to the file arguments. A file listed but named by no block and given no file-less block is refused.
- When the text holds a marker line itself (a Markdown `=======` underline), open with more characters, `<<<<<<<<<< SEARCH`, and divide and close with as many `=` and `>`.
- `--pairs <json|file>` (or `-` for stdin) applies a JSON array of `{ "from", "to", "count"?, "all"?, "regex"? }` in order, each on the previous one's result, all or nothing; a value starting with `[` is the JSON itself, any other key in a pair is refused. `--count`, `--all` and `--regex` are the defaults of pairs that do not set them.
- A file with CRLF endings matches a literal `--from` typed with plain newlines, and the replacement keeps CRLF.
- `--quiet` prints nothing on success. Each written file prints `<path>: N replacements on lines L, +added -removed`; `--diff` adds its unified diff (through the system's `diff`), `--dry-run` shows the same without writing.
- The file is rewritten in place, so its mode, owner and missing trailing newline stay.
- Exit codes: 0 written, 1 a replacement did not match as expected, 2 a usage error.
