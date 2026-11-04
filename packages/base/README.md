# base

Runs a command at HEAD or another ref for Claude Code, where a session would otherwise reach for `git stash` to see whether a test fails without its change: `base` checks the ref out in a temporary worktree, runs the command there and removes it, the working tree untouched.

```sh
bun install -g @kaynooo/cli-base
base --keep tests/NewTest.php -- vendor/bin/phpunit tests/NewTest.php
```

## Behaviour

- The ref is HEAD unless `--ref <rev>` names another commit; the command runs in the caller's folder of the worktree, `api/` in `api/`.
- `--keep <path>` (repeatable) copies a working-tree file or folder over, such as the new test of a red-then-green check; a path missing or outside the repository is refused before anything is created.
- The env files (`.env.local`, `.env.test.local`), `node_modules`, `vendor` and `.venv` the checkout has but git ignores are symlinked into the worktree, at any depth, so the run finds its dependencies and settings; `--no-link` leaves them out. Other ignored files (build output, caches) are not, so the ref's own are rebuilt; `--keep` copies one a run needs.
- The worktree is removed afterwards, on failure and on SIGINT, SIGTERM or SIGHUP too (passed on to the command), its links unlinked first so nothing is deleted through them.
- One argument holding spaces runs through `sh -c`: `base -- 'bun test a.test.ts | tail -5'`.
- A command run through `docker compose exec|run` or `docker exec` is refused: the container mounts the main checkout, not the temporary worktree, so it would not run at the ref.
- The exit code is the command's; a last stderr line says which ref ran, `base: ran at HEAD (1a2b3c4), exit 1`.
- Exit codes of its own: 2 a usage error, an unknown ref or a refused command, 127 a command that cannot start.

## proof

`proof` shows that a test fails before a change and passes after it, the check `base` makes by hand: it runs the command at HEAD (or `--ref <rev>`) in the same temporary worktree as `base`, then in the working tree, both captured.

```sh
proof --keep tests/NewTest.php -- vendor/bin/phpunit tests/NewTest.php
```

- `--ref`, `--keep`, `--no-link` and the single spaced argument through `sh -c` behave as in `base`.
- Four outcomes, each printed as one line followed by the output of the side that explains it: `fails at 1a2b3c4, passes now` (the proof, exit 0, the output before), `passes at 1a2b3c4 too: it does not fail without the change`, `fails at 1a2b3c4 and fails now too` (the output now) and `passes at 1a2b3c4, fails now` (the output now), all three exit 1.
- `--json` prints `{outcome, proved, ref, sha, before: {code, output}, now: {code, output}}`, `outcome` being `proved`, `passes-before`, `fails-both` or `regressed`.
- Exit codes: 0 fails before and passes now, 1 any other outcome, 2 a usage error, an unknown ref, a refused command, one that cannot start or one that ends with exit 126, 127 or a signal (or 128 plus the signal when interrupted).
