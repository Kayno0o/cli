# sub

Replaces text in files for Claude Code, where a session would otherwise retype a `sed -i`, a `bun -e` editor or a python heredoc: `sub` writes nothing unless every replacement matched as often as expected, and says where it did.

```sh
bun install -g @kaynooo/edit-tools
sub --from 'a.b(1)' --to 'a.c(2)' src/a.ts
```

## Behaviour

- `--from` is taken literally (`$`, `.`, `(` included) and must match exactly once per file; `--count N` expects N matches, `--all` replaces every match and expects at least one.
- `--to ''` deletes the match. A value starting with a dash goes as `--from=-x`.
- Several files at once (the shell's globs, or `rg -l X | xargs sub ...`): each is checked on its own, and one failing file leaves every file untouched.
- On a failure nothing is written, stderr lists each file and pair that failed, with the lines matched or, for a multiline `--from` found nowhere, the lines its first line is on (usually an indentation mismatch), and the exit code is 1.
- `--regex` makes `--from` a regular expression (`^` and `$` match each line), `--to` taking `$1` and `$<name>`.
- `--pairs <file>` (or `-` for stdin) applies a JSON array of `{ "from", "to", "count"?, "all"?, "regex"? }` in order, each on the previous one's result, all or nothing. `--count`, `--all` and `--regex` are the defaults of pairs that do not set them.
- A file with CRLF endings matches a literal `--from` typed with plain newlines, and the replacement keeps CRLF.
- Each written file prints `<path>: N replacements on lines L, +added -removed`; `--diff` adds its unified diff (through the system's `diff`), `--dry-run` shows the same without writing.
- The file is rewritten in place, so its mode, owner and missing trailing newline stay.
- Exit codes: 0 written, 1 a replacement did not match as expected, 2 a usage error.
