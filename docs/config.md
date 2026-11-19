# Configuration

Every file below is optional, nothing is assumed without it. The user files live in `~/.config/kaynooo-cli/` (`$XDG_CONFIG_HOME/kaynooo-cli/` when that is set). A file of a bin's own settings that does not parse is ignored with a warning (`config.json` and `pkg-excluded.json` silently, `repos.json` ends `ws repos` with exit 1).

## Files

| File | Read by | Keys |
|---|---|---|
| `~/.config/kaynooo-cli/config.json` | `doctor`, `gcl`, `dl`, `pkg`, `ws repos`, `ws sweep` | `workspace`: the folder holding the repositories (`doctor --install` writes it); `forge`: your forge, a host (`git.example.org`) or a URL: `gcl owner/name` clones from it over https, `dl fj:owner/repo` reads its releases, `doctor` wants a tea login to it (any login when unset); `forgeSsh`: the forge's ssh address (`git@host`, `ssh://git@host:port`) `gcl owner/name` clones from first |
| `~/.config/kaynooo-cli/theme.json` | every bin | `preset`, `colors`, `glyphs`, `accents`, `gradient`, `bins`: see [Theme](#theme) |
| `.kaynooo/theme.json` | every bin | the same, found upward from the current folder to the repository root, laid over the user file |
| `~/.config/kaynooo-cli/ft.json` | `ft` | `remoteHost`: the ssh host `ft remote` switches alias origins to (the older `~/.config/ft/config.json` is read when this one is missing) |
| `~/.config/kaynooo-cli/db.json` | `db` | `allowedHosts`: hosts other than loopback and compose services that `db` may connect to (the older `~/.config/db/config.json` is read when this one is missing) |
| `~/.config/kaynooo-cli/doctor.json` | `doctor` | `forgeHosts`: other hosts the forge answers on, accepted for the tea login check |
| `~/.config/kaynooo-cli/pkg.json` | `pkg` | `licenses`, `blockSeverity`, `minAge`: the same keys as `.pkgrc.json` |
| `.pkgrc.json` | `pkg` | `licenses`, `blockSeverity`, `minAge`, found upward, the nearest file that sets a key wins |
| `~/.config/kaynooo-cli/pkg-excluded.json` | `pkg bump` | the folders left out of a package's bumps, `{ "<package>": ["<folder>"] }`: written by the checklist, editable |
| `~/.config/kaynooo-cli/repos.json` | `ws repos` | `skip`: repository names left out |
| `.npmrc`, `bunfig.toml` | `pkg` | the registry and token of a scope, read as `bun` reads them |
| `changelog.config.{ts,mts,js,mjs,json}`, the `changelog` field of `package.json` | `changelog` | the release notes: repo, groups, Discord webhook |

## Theme

Every bin draws with one theme: the default, then the `preset` a file names, then `~/.config/kaynooo-cli/theme.json`, then `.kaynooo/theme.json` found upward to the repository root, each over the last. `KIT_THEME=mono` or `KIT_THEME=<file>` replaces all of that for one run.

```json
{
  "preset": "high-contrast",
  "colors": { "accent": "magenta", "ok": "#22c55e", "id": 208, "path": "bold blue" },
  "glyphs": { "ok": "✔", "bar": "▬" },
  "gradient": ["#c084fc", "#67e8f9"],
  "bins": { "ft": "magenta" }
}
```

| Key | Takes |
|---|---|
| `preset` | `default`, `high-contrast` (bright colours), `mono` (bold, dim and underline only) or `ascii` (glyphs in plain ASCII) |
| `colors` | a colour per role: `accent`, `id`, `path`, `label`, `value`; per mark: `ok`, `warn`, `problem`, `note`, `plan`; per status: `passed`, `failed`, `running`, `queued`, `skipped` |
| `glyphs` | one column wide each: the marks and statuses above, `bar`, `rule`, `corner`, and `open`, `leaf`, `guide` for trees |
| `accents` | the colours a bin's header picks from by its name |
| `bins` | a header colour per bin, over `accents` |
| `gradient` | the two `#rrggbb` ends bars and sparklines blend between, or `null` to draw them in the accent |

A colour is an ANSI name or style (`cyan`, `redBright`, `bold blue`), a 256-colour index or `#rrggbb`. A bad value is reported once on stderr and skipped, the rest still applies. A theme file is JSON only, so a project's file cannot run anything, and nothing drawn off a terminal or under `NO_COLOR` changes.

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `NO_COLOR`, `FORCE_COLOR`, `NODE_DISABLE_COLORS`, `COLORTERM`, `TERM` | every bin | the usual colour switches; `--color` and `--plain` win |
| `KIT_MODE` | every bin | `terminal`, `ci`, `agent` or `pipe`, forcing how the output is shaped; `CLAUDECODE` and `AI_AGENT` select `agent` |
| `KIT_THEME` | every bin | a preset name, or the theme file to use instead of the others |
| `KIT_HELP` | every bin | `json` makes `--help` print a machine-readable description |
| `KAYNOOO_WORKSPACE` | `doctor`, `pkg`, `ws repos`, `ws sweep` | the folder holding the repositories, over `config.json` |
| `KAYNOOO_CLI_NO_USAGE` | every bin | anything but `0` or empty stops the run being recorded in `usage.jsonl` |
| `BROWSER` | `--open` | the command opening a URL, else the platform's opener |
| `EDITOR`, `VISUAL` | prompts | the editor a prompt that asks for a text opens |
| `CI` | every bin | selects the `ci` output mode, like a pipeline's log |
| `XDG_CONFIG_HOME` | every bin | where `kaynooo-cli/` config files are read from |
| `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` | `doctor`, `out`, `check`, the usage log | where completions, saved logs, state and run logs live |
| `BUN_INSTALL` | `doctor` | where Bun's global packages are looked for |
| `SLOT_DIR` | `slot` | where the slot locks are kept |
| `PAGE_CHROMIUM`, `PLAYWRIGHT_BROWSERS_PATH` | `page` | the Chrome or Chromium binary to drive, else the folder of Playwright's downloaded builds (`~/.cache/ms-playwright`) |
| `COMPOSE_FILE`, `COMPOSE_PATH_SEPARATOR` | `check`, `docker`, `env`, `stack` | the compose files, as `docker compose` reads them |
| `POSTGRES_*`, `MYSQL_*`, `MARIADB_*` | `db` | the credentials of a database service, read from its compose environment, `*_FILE` variants included |
| `GITHUB_TOKEN` | `changelog` | the Forgejo token when `--token` is not given |
| `DISCORD_WEBHOOK` | `changelog` | the webhook the release is posted to when `--discord-webhook` is not given |
| `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR` | `ft`, `waitfor` | where Claude Code keeps its sessions, and the temporary folder a background task writes to |

`cli config` shows which of these files this host has, and the main variables set. `<bin> <command> --help` lists each bin's flags, `bun run docs` regenerates [bins.md](bins.md).
