# proc

Three process and port helpers for Linux, reading `/proc` directly instead of shelling out to `ps`, `ss` or `lsof`: `proc pid` inspects one process, `proc ports` tells who listens on what, `proc procs` finds leftover or heavy dev processes.

```sh
bun install -g @kaynooo/cli-proc
```

## Commands

| Command | What it does |
| --- | --- |
| `proc pid <pid>` | executable, working directory, command line, parent chain up to init, user, start time and age, memory, open files and limits, the TCP and UDP ports it listens on, cgroup; `--env` adds the environment with secrets masked, `--json` everything |
| `proc ports [port]` | the listening sockets (TCP and UDP, IPv4 and IPv6) with port, protocol, bound address, pid, command and working directory; a port Docker publishes shows its compose project and service |
| `proc ports <port> --kill` | stops the owner: SIGTERM, and with `--force` SIGKILL after `--grace` (5s); asks on a terminal unless `--yes` |
| `proc procs` | leftover or heavy dev processes grouped by origin, with count, total RSS and oldest age |
| `proc procs --kill` | a dry run naming what would be stopped; `--yes` sends SIGTERM, then SIGKILL after `--grace` |

## proc pid

A missing pid exits 1. What the calling user cannot read of another user's process (executable, working directory, open files, limits, environment) is left out and named at the end. The environment is off unless `--env` is given: a name that looks like a secret (kit's rule, shared with `ev` and `redact`) has its whole value masked, and a URL password, a well known token format, a private key or a long opaque token is masked inside any value; the command line is masked the same way.

## proc ports

Sockets come from `/proc/net/{tcp,tcp6,udp,udp6}` and are mapped to their owner through the inode in `/proc/<pid>/fd`, so only the calling user's processes show an owner; the others show `-`. A socket without a readable owner, or held by `docker-proxy`, takes the container publishing its port when `docker ps` answers (skipped quietly when docker is missing or its daemon unreachable).

`proc ports <port>` exits 1 when nothing listens there. `--kill` refuses a process of another user, pid 1, this command and its ancestors, and a container's port, for which it prints the `docker stop <container>` to run instead.

## proc procs

A process is listed when it is a dev tool (bun, node, vite, nuxt, next, chromium and chrome, playwright and WebKit browsers and their helpers, language servers, test runners) of the calling user and either:

- an orphan: reparented to init or to the user's systemd, outside a systemd service of its own; a browser counts only as a helper (`--type=`) or when a script drives it (`--headless`, `--remote-debugging-*`), and the crashpad handler never, as it detaches by design;
- heavy: 500M resident or more.

The dev processes below a listed one, and those sharing its `--user-data-dir`, are listed with it, so a chromium whose main process was killed groups with its leftover helpers. Groups are named after the git root (else the nearest package manifest) of the working directory under the home folder, the browser profile, or else the command.

`--min-mem <size>` (`500M`, `1.5G`, a bare number counting megabytes) sets the heavy bar and the least a left over process must use; `--older <duration>` (`30m`, `2h`, `1d`) keeps the processes at least that old. `--kill` never touches pid 1, shells, terminals, this command and its ancestors, or other users' processes, and counts the ones it left out.

Linux only. Start times assume the usual 100 clock ticks per second.
