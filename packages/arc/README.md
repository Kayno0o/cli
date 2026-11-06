# @kaynooo/cli-arc

`arc` packs a folder into a `.tar.zst` it has verified before it deletes anything, unpacks one without overwriting a file, and extracts any other archive.

```sh
bun add -g @kaynooo/cli-arc
```

It needs `tar` and `zstd` on the machine (`findmnt`, `mountpoint` and `df` from util-linux and coreutils, `sudo` for folders you cannot read), and `unzip`, `unrar` or `7z` for `arc extract` of those kinds.

| Command | What it does |
| --- | --- |
| `arc pack [-k] <folder> <dest dir>` | packs the folder into `<dest dir>/<name>.tar.zst`, checks it, then deletes the folder; `-k` keeps it |
| `arc unpack <archive.tar.zst> <dest dir>` | unpacks it into the folder, refusing to overwrite, then checks every file against the archive; the archive is kept |
| `arc extract <file>` | extracts `.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2`, `.tar.xz`, `.tar.zst`, `.gz`, `.bz2`, `.zip`, `.Z`, `.rar` or `.7z` into the current folder, checking nothing |

## What `pack` checks before it deletes

- The archive is written as `<name>.tar.zst.partial` and renamed once complete; an existing archive or partial is never overwritten.
- It refuses a symlink, a mount point, a folder with a file system mounted inside (tar and `rm` would both skip it), a destination inside the folder, and a destination with less free space than the folder holds.
- The finished archive must pass zstd's checksum, list as many entries as the folder holds, and `tar --compare` equal to it, owners, ACLs and extended attributes included.
- Only then is the folder deleted, with `rm -rf --one-file-system`. Any failure before that leaves the folder as it was.
- A folder you cannot read or write is packed, compared and deleted through `sudo`.

## What `unpack` checks

The checksum first, then that no top-level entry of the archive already exists in the destination, and after extracting a `tar --compare` of every file. Owners are restored only as root, so `sudo` is used when the destination is not writable or the archive holds other owners than you.

Exits 0 on success, 1 when anything was refused or failed, 2 on a usage error.
