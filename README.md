# cli

CLIs built for Claude Code sessions, each published on its own from `packages/` to npmjs as `@kaynooo/cli-<name>`: `bun add -g @kaynooo/cli-<name>`. Only `@kaynooo/cli-changelog` stays on the Forgejo registry.

| Package | Bin | What it does |
| --- | --- | --- |
| [`@kaynooo/cli-forgejo`](packages/ft) | `ft` | Forgejo CI runs and failures, releases, issue checklists and issue claims between sessions, through tea |
| [`@kaynooo/cli-env`](packages/env) | `ev` | .env files listed and edited with secrets masked; secrets masked in any piped output |
| [`@kaynooo/cli-db`](packages/db) | `db` | read-only SQL against Postgres, MySQL and MariaDB (compose service or any container) that never shows the connection credentials, writes handed back as SQL unless the database ends in `_test` |
| [`@kaynooo/cli-check`](packages/check) | `check`, `errs`, `j` | a repo's check, typecheck, lint and test steps, or its fixers and formatters (`check --fix`), run inside the project's docker compose service when one mounts the folder, showing only what failed; a recipe, script or task of the repo picked and run; tsc, eslint, bun test, vitest, playwright, phpunit, phpstan, php-cs-fixer, go, cargo, ruff and pytest logs turned into `file:line:col` errors |
| [`@kaynooo/cli-pkg`](packages/pkg) | `pkg` | an npm package checked before it is added: guessed names, versions under two weeks old, install scripts; `pkg bump` moves every consumer repo onto a release once the registry serves it |
| [`@kaynooo/cli-stack`](packages/stack) | `stack` | a stable host port per service name, the same on every machine |
| [`@kaynooo/cli-docker`](packages/docker) | `dc`, `dx`, `dlog`, `sf` | `docker compose` on the stack found here, including one only its containers tell of; a compose service picked for its shell, logs, restart, stop or rebuild; every service's health and recent errors in one call; a Symfony console command picked and run in the php service |
| [`@kaynooo/cli-out`](packages/out) | `out` | noisy command output folded, errors kept, the full log saved to a file |
| [`@kaynooo/cli-edit`](packages/edit) | `sub` | text replaced in files, written only when every replacement matches as often as expected |
| [`@kaynooo/cli-base`](packages/base) | `base` | a command run at HEAD or another ref in a temporary worktree, instead of a `git stash` round trip; a test shown to fail before a change and pass after it |
| [`@kaynooo/cli-git`](packages/git) | `gst`, `gc`, `gb`, `gp`, `gf`, `gm`, `gcl`, `gd`, `gu` | a repository's state in one call; a commit of exactly the paths given, its message checked before anything is staged; a branch picked and switched to, created or deleted; a push only when ahead, a fetch that fast-forwards, a merge listing every conflict; a clone into the workspace, the changes per file, a discard saved as a patch first |
| [`@kaynooo/cli-wait`](packages/wait) | `waitfor`, `slot` | a wait on a log line, a listening port, a URL answering, a process exiting or a background task ending, ending early on an error line, instead of sleep and polling loops; heavy commands queued behind machine-wide slots and named locks, freed when their holder dies |
| [`@kaynooo/cli-gitlab`](packages/gitlab) | `gl` | GitLab pipelines waited on, listed and read, each failed job's trace cut to its failed tests, through glab |
| [`@kaynooo/cli-guard`](packages/guard) | `guard` | the safety rules a Claude Code Bash call is held to (remote machines, git, commit messages, SQL writes, env files, package managers, in-place edits), each refusal naming the route |
| [`@kaynooo/cli-code`](packages/code) | `src` | source read by spans, declarations, usages and outlines in one call; the TODO and issue-reference comments of a repository, those naming a closed issue flagged; the files ranked by complexity times git churn |
| [`@kaynooo/cli-changelog`](packages/changelog) | `changelog` | a release's notes generated from its conventional commits and published as a Forgejo release, posted to Discord too; a release undone |
| [`@kaynooo/cli-arc`](packages/arc) | `arc` | a folder packed into a `.tar.zst` verified file by file before it is deleted, unpacked without overwriting anything, any other archive extracted |
| [`@kaynooo/cli-dev`](packages/dev) | `dev` | small developer utilities: random passwords and bcrypt hashes, JWT decoding, timestamps, UUIDs and ULIDs, base64, URL parts, file hashes |
| [`@kaynooo/cli-dl`](packages/dl) | `dl` | a file downloaded into a folder of its own, checked by sha256 or a checksums file, then extracted, installed into `~/.local/bin` or run as a script once pinned; every URL remembered so a changed install script shows its diff, and a ledger of what was installed or run |
| [`@kaynooo/cli-gloss`](packages/gloss) | `gloss` | explains a shell command line, each option matched to its man page |
| [`@kaynooo/cli-pick`](packages/pick) | `pick` | a themed fuzzy selector, lines on stdin and the chosen one on stdout |
| [`@kaynooo/cli-probe`](packages/probe) | `probe` | a site's HTTP version, redirects, timings, TLS certificate and notable headers in one call |
| [`@kaynooo/cli-proc`](packages/proc) | `proc` | a process inspected from /proc (executable, parents, memory, limits, listening ports, masked environment); who listens on a port, Docker-published ports resolved to their compose service, with a safe `--kill`; leftover or heavy dev processes grouped by origin and cleaned dry-run first |
| [`@kaynooo/cli-workspace`](packages/workspace) | `ws` | the repositories of the workspace that need attention (dirty, unpushed, behind, unreleased); node_modules, build output and clean worktrees reclaimed across repos, dry by default; the known vulnerabilities of the Bun repositories in one table per repository |
| [`@kaynooo/cli-wt`](packages/wt) | `wt` | git worktrees of a compose project, each with its own stack, its own copy of the data and its own `<task>.<host>` subdomains through devproxy; manifests and a runner in a config file, job locks other tools can share |
| [`@kaynooo/cli-view`](packages/view) | `view` | a markdown file or a git diff shown in the colours of the other CLIs, wrapped to the terminal and paged when long |
| [`@kaynooo/cli-doctor`](packages/doctor) | `doctor`, `cli` | the whole install checked in one call: each bin's version against the registry, tea's login to Forgejo, the Claude Code hooks wired one way, the Bun floor, each failure with its fix; every bin in one line, what it does and what it replaces, read from its own help |
| [`@kaynooo/cli-kit`](packages/kit) | - | the CLI kit every @kaynooo CLI is built on: argument parsing with `--help`, the command dispatcher, prompts, the progress line, config loading, the shell command parser every guard reads with, and output helpers |

Every bin and command is described in [docs/bins.md](docs/bins.md), every config file and environment variable in [docs/config.md](docs/config.md).

## Development

```sh
bun install
bun run check && bun run lint && bun run test
```

`bun run test` starts the slowest files first, as `tests/timings.json` lists them; refresh it with `bun run test:timings` after adding a slow test file.

## Releasing

Each CLI releases on its own: `just release <folder> <patch|minor|major>` bumps `packages/<folder>`, tags it `<folder>-v<version>`, and the tag's workflow builds that folder (`bun run build`, a Bun bundle per bin with `packages/kit` inlined) and publishes it. Kit is published like the CLIs (`just release kit minor`) for the libs outside this repo; the CLIs here take it as `workspace:*` and inline it, so a kit change reaches one of them with its next release.

The same workflow then publishes the package to npmjs (`@kaynooo` org) with the `NPM_STAGE_TOKEN` secret, a granular staged-publish token on `@kaynooo`, through `npm stage publish` since `bun publish` finds no auth for npmjs. The version is staged, not live: approve it with `npm stage approve <stage-id>` (`npm stage list` shows the pending ones). npm ends direct publishing for bypass-2FA tokens around January 2027, and trusted publishing does not support Forgejo, so staged publishing is the fallback; Forgejo has no OIDC, so there is no `--provenance`.

## Claude Code

Two ways wire the bins into Claude Code, never both on one host:

- **The `cli-hooks` plugin** in this repo, for any host: `guard hook` answers each event, refusing a Bash call that breaks a rule (with the command to run instead, the pinned package manager included), an install `pkg` refuses and a Read, Edit or Write of an env file, letting `git push` through only when the latest prompt asked for one, and listing the installed bins at session start. A hook cannot swap the command Claude runs without approving it too, so nothing runs through `out` here.
- **The `cli` mod** in the user's dotfiles (`zshrc/dotfiles/claude/mods/cli`): the same rules through `guard check`, plus the install rewritten to the pinned manager and noisy runs through `out`.

### A host without the dotfiles

```sh
bun install -g @kaynooo/cli-doctor
doctor --install
```

`doctor --install` lists the packages in a checklist, with what each needs on the machine, and the Claude Code hooks plugin among them; name them instead (`doctor --install forgejo check hooks`, or `all`) off a terminal. A package whose required tool is missing (tea for `ft`, glab for `gl`, docker for `dc`) is left out unless `--force`, and `hooks` brings `guard` along. `doctor` alone checks what is installed and `doctor --fix` repairs it, the hooks plugin and the completions included.

The packages come from npmjs with no registry setup. Each is also published to the Forgejo registry, which answers without a token; to install from it instead, map the scope first: `printf '[install.scopes]\n"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"\n' >> ~/.bunfig.toml`. The plugin comes from the Forgejo marketplace either way.

The hooks need `@kaynooo/cli-guard` or later, the first with `guard hook`. Claude Code caches a plugin by its version, so a change under `plugin/` bumps `plugin/.claude-plugin/plugin.json` to reach the hosts.

`~/.bun/bin` must be on the PATH Claude Code starts with, or the hooks find no `guard`: Claude Code then reports a hook error on each call and lets it through. In a session, `/plugin marketplace add https://github.com/Kayno0o/cli.git` then `/plugin install cli-hooks@kaynooo-cli` does the same as the last line.
