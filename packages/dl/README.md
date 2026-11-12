# @kaynooo/cli-dl

`dl` downloads a file into a folder of its own and checks its sha256, and its signature when asked. It can then extract the file, install it as a command, or run it as a script once a sha256 pins it.

```sh
bun add -g @kaynooo/cli-dl
```

`--extract` and `--bin` on an archive need the archive's extractor on PATH (tar, unzip, unrar or 7z), as `arc extract` does. A changed text file's diff needs git.

| Command | What it does |
| --- | --- |
| `dl <url>` | downloads into a new folder under the temp folder (`-o <dir>` to choose one, never overwriting), and prints the path, size, final URL, type, sha256 and how it compares with the last download of that URL |
| `dl ls` | the commands `dl` installed and the scripts it ran, with where each came from and when |

| Option | What it does |
| --- | --- |
| `--sha256 <hex>` | the sha256 the file must have; on a mismatch the file is deleted |
| `--sums <url>` | a checksums file (`SHA256SUMS`, `sha256sum` or BSD style, or a lone hash) giving the file's sha256 |
| `--sig <url> --key <key>` | a detached signature of the file, or of the `--sums` file when there is one, checked before the file is kept; `--key` is a gpg fingerprint of your keyring or a gpg key file, a minisign key or key file, or a cosign PEM file, and that tool must be on PATH |
| `--extract`, `-x` | unpacks the archive into a new folder beside it |
| `--bin [name]` | installs the file, or the one executable its archive holds, into `~/.local/bin`; `--force` replaces a command already there |
| `--exec` | lists what the script does, then runs it only when `--sha256`, `--sums` or `--sig` pins it, or with `--yes`; arguments after `--` go to the script |
| `--max-size <size>` | the largest download taken, `2G` by default |

An HTML page arriving where a file was expected (an error or sign-in page answered with 200) fails instead of being kept.

## Install scripts

`curl -fsSL https://bun.sh/install | bash` runs code nobody read. With `dl`:

```sh
dl https://bun.sh/install                                # prints the path and sha256
dl https://bun.sh/install --exec --sha256 <sha>          # runs exactly what was read
```

`--exec` first lists the lines worth reading: what the script fetches, what it runs with sudo, recursive removals, shell profiles and system folders it touches, code it hands to a shell, and the environment variables it reads.

Every URL is remembered under `~/.local/state/kaynooo-cli/dl`. Downloading the same URL again says whether it changed, and a text file under 1 MB shows its diff against the last version, so a script you read before only needs its changes read again.

A checksums file fetched from the same server as the file only proves the download arrived whole; a signature proves who published it. Most projects sign the checksums file, so `--sums` and `--sig` together check both.

Exits 0 on success, 1 when the download, a check, an extraction, an install or the script fails, or a script nothing pins was not run, 2 on a usage error.
