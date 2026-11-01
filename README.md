# agent-tools

CLIs built for Claude Code sessions, each published on its own from `packages/`.

| Package | Bin | What it does |
| --- | --- | --- |
| [`@kaynooo/forgejo-tools`](packages/ft) | `ft` | Forgejo CI runs and failures, releases, issue checklists and issue claims between sessions, through tea |
| [`@kaynooo/env-tools`](packages/env) | `ev`, `redact` | .env files listed and edited with secrets masked; secrets masked in any piped output |
| [`@kaynooo/db-tools`](packages/db) | `db` | read-only SQL against Postgres that never shows the connection credentials, writes handed back as SQL |
| [`@kaynooo/check-tools`](packages/check) | `check`, `fix` | a repo's check, typecheck, lint and test steps, or its fixers and formatters, showing only what failed |
| [`@kaynooo/pkg-tools`](packages/pkg) | `pkg` | an npm package checked before it is added: guessed names, versions under two weeks old, install scripts; `pkg bump` moves every consumer repo onto a release once the registry serves it |
| [`@kaynooo/stack-tools`](packages/stack) | `stack` | a stable port per service name, and a compose release setup audited against its `release.config.ts` |
| [`@kaynooo/out-tools`](packages/out) | `out` | noisy command output folded, errors kept, the full log saved to a file |
| [`@kaynooo/edit-tools`](packages/edit) | `sub` | text replaced in files, written only when every replacement matches as often as expected |
| [`@kaynooo/base-tools`](packages/base) | `base` | a command run at HEAD or another ref in a temporary worktree, instead of a `git stash` round trip |
| [`@kaynooo/git-tools`](packages/git) | `gst`, `gc` | a repository's state in one call; a commit of exactly the paths given, its message checked before anything is staged |
| [`@kaynooo/wait-tools`](packages/wait) | `waitfor` | a wait on a log line, a listening port, a URL answering, a process exiting or a background task ending, ending early on an error line, instead of sleep and polling loops |
| [`@kaynooo/gitlab-tools`](packages/gitlab) | `gl` | GitLab pipelines waited on, listed and read, each failed job's trace cut to its failed tests, through glab |
| [`@kaynooo/guard-tools`](packages/guard) | `guard` | the safety rules a Claude Code Bash call is held to (remote machines, git, commit messages, SQL writes, env files, package managers, in-place edits), each refusal naming the route |
| [`@kaynooo/code-tools`](packages/code) | `peek`, `todo-scan` | source read by spans, declarations, usages and outlines in one call; the TODO and issue-reference comments of a repository, those naming a closed issue flagged |
| [`@kaynooo/doctor-tools`](packages/doctor) | `doctor` | the whole install checked in one call: each bin's version against the registry, tea's login to Forgejo, the Claude Code hooks wired one way, the Bun floor, each failure with its fix |
| [`@kaynooo/cli-kit`](packages/kit) | - | the CLI kit every @kaynooo CLI is built on: argument parsing with `--help`, the command dispatcher, prompts, the progress line, config loading, the shell command parser every guard reads with, and output helpers |

## Development

```sh
bun install
bun run check && bun run lint && bun run test
```

## Releasing

Each CLI releases on its own: `just release <folder> <patch|minor|major>` bumps `packages/<folder>`, tags it `<folder>-v<version>`, and the tag's workflow builds that folder (`bun run build`, a Bun bundle per bin with `packages/kit` inlined) and publishes it. Kit is published like the CLIs (`just release kit minor`) for the libs outside this repo; the CLIs here take it as `workspace:*` and inline it, so a kit change reaches one of them with its next release.

The same workflow then publishes the package to npmjs (`@kaynooo` org) with the `NPM_TOKEN` secret, a granular token with read and write on `@kaynooo` and the bypass 2FA option, through `npm publish` since `bun publish` finds no auth for npmjs. npm plans to end direct publishing for bypass-2FA tokens around January 2027: trusted publishing does not support Forgejo, so staged publishing is the fallback.

## Claude Code

Two ways wire the bins into Claude Code, never both on one host:

- **The `agent-tools-hooks` plugin** in this repo, for any host: `guard hook` answers each event, refusing a Bash call that breaks a rule (with the command to run instead, the pinned package manager included), an install `pkg` refuses and a Read, Edit or Write of an env file, letting `git push` through only when the latest prompt asked for one, and listing the installed bins at session start. A hook cannot swap the command Claude runs without approving it too, so nothing runs through `out` here.
- **The `agent-tools` mod** in the user's dotfiles (`zshrc/dotfiles/claude/mods/agent-tools`): the same rules through `guard check`, plus the install rewritten to the pinned manager and noisy runs through `out`.

### A host without the dotfiles

```sh
# the @kaynooo scope resolves from this registry, which answers without a token
printf '[install.scopes]\n"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"\n' >> ~/.bunfig.toml
bun install -g @kaynooo/forgejo-tools @kaynooo/env-tools @kaynooo/db-tools @kaynooo/check-tools @kaynooo/pkg-tools @kaynooo/stack-tools @kaynooo/out-tools @kaynooo/edit-tools @kaynooo/base-tools @kaynooo/git-tools @kaynooo/wait-tools @kaynooo/gitlab-tools @kaynooo/guard-tools @kaynooo/code-tools @kaynooo/doctor-tools
claude plugin install agent-tools-hooks --marketplace https://git.kaynooo.fr/kaynooo/agent-tools.git
```

Every package is also on npmjs, so a host that cannot reach git.kaynooo.fr installs the bins without the scope mapping: `bun install -g @kaynooo/guard-tools` and the others. The plugin still comes from the Forgejo marketplace.

The hooks need `guard-tools` 0.2.0 or later, the first with `guard hook`. Claude Code caches a plugin by its version, so a change under `plugin/` bumps `plugin/.claude-plugin/plugin.json` to reach the hosts.

`~/.bun/bin` must be on the PATH Claude Code starts with, or the hooks find no `guard`: Claude Code then reports a hook error on each call and lets it through. In a session, `/plugin marketplace add https://git.kaynooo.fr/kaynooo/agent-tools.git` then `/plugin install agent-tools-hooks@agent-tools` does the same as the last line.
