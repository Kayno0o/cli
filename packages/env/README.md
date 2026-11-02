# env-tools

Two CLIs that keep secrets out of a Claude Code transcript: `ev` lists and edits `.env` files with every secret masked, and `redact` masks secrets in any piped output.

```sh
bun install -g @kaynooo/env-tools
```

## ev

| Command | What it does |
| --- | --- |
| `ev list [file]` | every key of the folder's `.env*` files (or one file), secrets masked |
| `ev get KEY [file]` | one key's masked value, from every file that sets it or from one |
| `ev grep [-i] <regex> [file...]` | the keys matching the regex (matched against the key, never the value), values masked |
| `ev show <rev>:<file>` | an env file as a git revision holds it, values masked |
| `ev set KEY [file]` | sets a key in `.env` (or the file), the value read from stdin or `-F <file>` so it never appears in a command line, `--empty` for an empty value |
| `ev unset KEY [file]` | removes a key |
| `ev mv KEY --from <file> --to <file>` | moves a key's line as written, `--force` to replace one the target has |
| `ev diff <a> <b>` | names the keys set in one file and not the other, exit 1 when they differ |
| `ev missing [file]` | names the keys of `.env.example` (`--against`) that the file lacks, exit 1 when some are |
| `ev audit [dir...]` | lists the `.env` files any account can read or git tracks, and the compose files any account can read that write a secret or URL password out, with the fix for each, exit 1 when it finds one |
| `ev audit --fix [dir...]` | moves each secret a listed compose file writes out into the `.env` beside it as `${KEY}` (a key the `.env` sets to another value stays put), puts it back when `docker compose config` resolves differently, and shuts other accounts out of both files and of every listed `.env`; exit 1 when something is left |

A value is masked when its key looks like `TOKEN|SECRET|PASSWORD|KEY|PRIVATE|DSN`, when it is a private key, or in the password part of any URL (`postgres://user:***@host/db`) and any known token format. A URL is also masked where it carries a token, whatever its key is named: the last segment of a Discord, Slack, Uptime Kuma push or healthchecks.io ping URL, any path segment of 20 or more characters of `A-Za-z0-9_-` mixing lowercase, uppercase and digits, any path segment of 32 or more letters and digits of any case (hex, base32, dashless UUIDs), and the value of a query parameter named `token`, `key`, `apikey`, `secret`, `password`, `sig`, `signature`, `auth` or ending in `_token` or `_secret`; the host and the rest of the URL stay readable. A masked value keeps a few leading characters and its length (`ghp***(40)`) so two values can be told apart. There is no flag that prints a secret unmasked.

Files are parsed and written back preserving comments, order, `export KEY=` prefixes, quoting and multiline values; only the lines a command touches change.

## redact

```sh
some-command 2>&1 | redact
git diff --cached | redact --check
```

`redact` copies stdin to stdout line by line, masking:

- known token formats: `ghp_`, `github_pat_`, `glpat-`, `sk-`, `xox?-`, JWTs and the body of PEM private key blocks
- the password and the tokens of any URL (webhook and push URLs, opaque path segments, token query parameters)
- the values of secret-looking keys in the `.env*` files of the current folder (whole words only, from 6 characters), `--no-env` skips them

`redact --check` prints nothing of the input: it lists `<file>:<line>: <kind>` for each secret found and exits 1. On a diff it reads the added lines only and names the new file's line numbers.

## The parser and the guard

`import { parseDotenv, entries } from '@kaynooo/env-tools/dotenv'` gives the dotenv parser ev reads with: quotes, `export` prefixes, comments and multiline values. `src/guard.ts` holds the env file rules the `guard` bin of `@kaynooo/guard-tools` runs, exported to it as `./guard` within the workspace only.
