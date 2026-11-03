# @kaynooo/cli-dev

`dev` is a toolbox of small developer utilities in one bin, each a command that reads its text from an argument or from stdin.

```sh
bun add -g @kaynooo/cli-dev
```

| Command | What it does |
| --- | --- |
| `dev password [length] [format] [-b\|--bcrypt [password]]` | `length` random bytes (default 32) as `hex`, `base64` (default) or `base64url`, printed and copied with `wl-copy` when it exists; `--bcrypt` prints the hash of the password given, or of a generated one |
| `dev jwt [token]` | header and payload of a JWT, `iat`, `nbf` and `exp` as local and UTC dates with how far from now; the signature is not verified |
| `dev ts [value]` | epoch seconds or milliseconds (told apart by size), an ISO date or date-time, or a duration such as `90m` or `2h30m`, as local and UTC dates; no value is now, `-` reads stdin |
| `dev uuid [-n <count>] [--v7]` | random UUIDs, version 4 or 7 |
| `dev ulid [-n <count>]` | random ULIDs |
| `dev b64 [-d] [--url] [text]` | base64 of the text, or with `-d` the text behind it (either alphabet, padding optional) |
| `dev url [url]` | the parts of a URL and its decoded query |
| `dev hash <sha256\|sha1\|md5\|sha512> [file]` | the hex digest of a file or of stdin |

`--json` prints the structured result of every command. `jwt` and `ts` take `--zone <IANA zone>` for the local dates instead of the host's.

Fish completes it through the bin itself: `dev __complete`, installed for every bin by `cli completions fish --install`.

## Passwords and bcrypt

The password is read from `crypto.getRandomValues` and written as `openssl rand -hex|-base64` does, `base64url` being that base64 with `+/` swapped for `-_` and the padding dropped. With a clipboard tool (`wl-copy`) the password is copied and `copied to clipboard` is said on stderr; `--no-copy` leaves the clipboard alone.

`--bcrypt` hashes at cost 10. Bun writes bcrypt hashes with the `$2b$` prefix where `htpasswd -B` writes `$2y$`: the algorithm is identical, so `dev` rewrites the prefix to `$2y$`, the one Apache, nginx and traefik basic auth all accept (`$2b$` is accepted by fewer of them). With a generated password the hash prints on stdout, the password on stderr, and it is the password that is copied, as the password it replaces did.

## Notes

- `ts` reads an ISO date-time without a zone, and a bare date, in the local zone (`--zone` to change it); one ending in `Z` or an offset carries its own. A number of 12 digits or more is milliseconds.
- `ts` reads stdin only for `-`, so a bare `dev ts` always means now, even in a script whose stdin is a pipe.
- `b64` encodes the bytes it is given, so `echo hi | dev b64` includes the newline, as `base64` does.
- Exit codes: 0 done, 1 the input could not be read (not a JWT, not base64, no such file), 2 a usage error.
