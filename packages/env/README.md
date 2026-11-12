# ev and redact

`ev` keeps secrets out of a Claude Code transcript: it lists and edits `.env` files with every secret masked, and `ev redact` masks secrets in any piped output.

```sh
bun install -g @kaynooo/cli-env
```

## ev

| Command | What it does |
| --- | --- |
| `ev list [file]` | every key of the folder's `.env*` files (or one file), secrets masked; `--json` prints `[{file, key, value, secret}]` (as for `get`, `grep` and `show`) |
| `ev get KEY [file]` | one key's masked value, from every file that sets it or from one |
| `ev grep [-i] <regex> [file...]` | the keys matching the regex (matched against the key, never the value), values masked |
| `ev show <rev>:<file>` | an env file as a git revision holds it, values masked |
| `ev set KEY [file]` | sets a key in `.env` (or the file), the value read from stdin or `-F <file>` so it never appears in a command line, `--empty` for an empty value |
| `ev unset KEY [file]` | removes a key |
| `--quiet` (`-q`) | on set, unset, cp and mv, prints nothing on success |
| `ev cp KEY --from <file> --to <file>` | copies a key's value to another file without printing it, replacing the key there or appending it, `--as NEWKEY` to rename |
| `ev mv KEY --from <file> --to <file>` | moves a key's line as written, `--force` to replace one the target has |
| `ev diff <a> <b>` | names the keys set in one file and not the other, and those set to different values with both masked as `list` shows them, exit 1 when they differ; `--keys` compares the keys only, `--json` prints `{a, b, onlyA, onlyB, differ}` |
| `ev missing [file]` | names the keys of `.env.example` (`--against`) that the file lacks, exit 1 when some are; `--json` prints `{a, b, onlyA, onlyB}` with the reference as `a` |
| `ev pins [dir]` | checks an app's tests pin the env that reaches outside (see below), exit 1 when something is unpinned |
| `ev audit [dir...]` | lists the `.env` files any account can read or git tracks, and the compose files any account can read that write a secret or URL password out, never printing a value, with the fix for each, exit 1 when it finds one; it looks down to 5 levels, skipping `node_modules`, `vendor`, `.git` and `.example`, `.sample`, `.template` and `.dist` files, and names a folder it cannot read on stderr |
| `ev audit --fix [dir...]` | moves each secret a listed compose file writes out into the `.env` beside it as `${KEY}` (a key the `.env` sets to another value stays put), puts it back when `docker compose config` resolves differently, and shuts other accounts out of both files and of every listed `.env`; exit 1 when something is left |

`ev pins` lists, by name only, the optional URL, key, token, secret, password and host variables of the app's `defineEnv` schema that no `.env.test` entry, test `overrideEnv` or local bunfig preload dropping what `.env` sets pins, and each test file calling `testSite` or `proxyKeyTests` without pinning them. `// ev pins: none reached, <why>` exempts a file. The `dir` is an app, or a monorepo holding apps one level down (the current folder by default); only variable names are read.

A value is masked when its key is named like a secret (`TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `PWD`, `KEY`, `PRIVATE`, `DSN`, `AUTH`, `SALT`, `COOKIE`, `CREDENTIALS`, the definition `isSecretName` of `@kaynooo/cli-kit` that `db` shares), when it equals a secret value of the folder's `.env*` files whatever its own key, when it is a private key (PEM or PGP, also escaped on one line), or in the password part of any URL (`postgres://user:***@host/db`) and any known token format (GitHub, GitLab, Slack, AWS, npm, Stripe, Google, SendGrid, `sk-`, JWTs, `Authorization` credentials, and a `name=value` or `"name": "value"` pair whose name `isSecretName` calls secret, `PGPASSWORD` or `clientSecret` alike, unless it names a setting such as `TOKEN_TTL` or `PASSWORD_FILE`). A variable printed at the start of a line, as `printenv` does, is masked to the end of the line. A URL is also masked where it carries a token, whatever its key is named: the last segment of a Discord, Slack, Uptime Kuma push or healthchecks.io ping URL, any path segment of 20 or more characters of `A-Za-z0-9_-` mixing lowercase, uppercase and digits, any path segment of 32 or more letters and digits of any case (hex, base32, dashless UUIDs), and the value of a query parameter named `token`, `key`, `apikey`, `secret`, `password`, `sig`, `signature`, `auth` or ending in `_token` or `_secret`; the host and the rest of the URL stay readable. A masked value keeps a few leading characters and its length (`ghp***(40)`) so two values can be told apart. There is no flag that prints a secret unmasked.

Files are parsed and written back preserving comments, order, `export KEY=` prefixes, quoting and multiline values; only the lines a command touches change.

`list`, `get`, `grep`, `show`, `diff` and `missing` also read a JSON (comments allowed), JSON5, YAML or TOML file named on the command line, its keys as dotted paths: `ev get database.password config.yaml`, `servers.0.host` for an array item. Writes stay on dotenv files: `set`, `unset`, `cp` and `mv` refuse those formats with exit 2. A file named with a `.ini` or `.xml` extension, or holding lines but no `KEY=value` one, is refused with exit 2 rather than read as empty; `ev redact < file` masks the secrets of those.

## ev redact

```sh
some-command 2>&1 | ev redact
git diff --cached | ev redact --check
```

`ev redact` copies stdin to stdout line by line, masking:

- known token formats: `ghp_`, `github_pat_`, `glpat-`, `sk-`, `xox?-`, JWTs and the body of PEM private key blocks
- the password and the tokens of any URL (webhook and push URLs, opaque path segments, token query parameters)
- the values of secret-looking keys in the `.env*` files of the current folder and the folders below it (whole words only, from 4 characters, also in their percent-encoded and JSON-escaped forms), `--no-env` skips them

`ev redact --check` prints nothing of the input: it lists `<file>:<line>: <kind>` for each secret found and exits 1. On a diff it reads the added lines only and names the new file's line numbers.

## The parser and the guard

`import { parseDotenv, entries } from '@kaynooo/cli-env/dotenv'` gives the dotenv parser ev reads with: quotes, `export` prefixes, comments and multiline values. `src/guard.ts` holds the env file rules the `guard` bin of `@kaynooo/cli-guard` runs, exported to it as `./guard` within the workspace only.
