# Configuration

Every file below is optional, nothing is assumed without it. User config lives in `~/.config/kaynooo-cli/config.jsonc` (or `config.json`, under `$XDG_CONFIG_HOME/kaynooo-cli/` when set), with per-tool sections and JSONC comments supported everywhere. Legacy per-bin files (`theme.json`, `ft.json`, `db.json`, `pkg.json`, `doctor.json`, `repos.json`, `out.json`, `dlog.json`, `wait.json`, `hotspots.json`, `audit.json`) remain supported as fallbacks, with keys in `config.jsonc` taking precedence. Manage keys with `cli config`, `cli config get <key>`, `cli config set <key> <value>`, `cli config unset <key>`, `cli config edit`, or `cli config init`.

## Unified `config.jsonc` sections

| Section / key | Read by | Keys |
|---|---|---|
| Top-level (`config.jsonc` / `config.json`) | `changelog`, `doctor`, `gcl`, `dl`, `pkg`, `ws`, `src` | `workspace`: folder holding repositories (`cli config init` / `doctor --install` writes it); `forge`: host (`git.example.org`) or URL; `forgeSsh`: forge SSH address (`git@host`, `ssh://git@host:port`); `ignore`: extra folder names skipped during repo scans |
| `theme` (or legacy `theme.json`) | every bin | `preset`, `colors`, `glyphs`, `accents`, `gradient`, `bins`: see [Theme](#theme) |
| `ft` (or legacy `ft.json`, `~/.config/ft/config.json`) | `ft` | `remoteHost`: ssh host `ft remote` switches alias origins to; `concurrency`: max concurrent forge API calls |
| `db` (or legacy `db.json`, `~/.config/db/config.json`) | `db` | `allowedHosts`: non-local hosts `db` may connect to |
| `doctor` (or legacy `doctor.json`) | `doctor` | `forgeHosts`: extra hosts accepted for the tea login check; `concurrency`: registry check concurrency |
| `pkg` (or legacy `pkg.json`, `.pkgrc.json`) | `pkg` | `licenses`, `blockSeverity`, `minAge`, `concurrency`, `trusted` |
| `repos` (or legacy `repos.json`) | `ws repos` | `skip`: repository names left out; `concurrency`: repo scan concurrency |
| `audit` (or legacy `audit.json`) | `ws audit` | `concurrency`: concurrent repo audits |
| `out` (or legacy `out.json`) | `out` | `lines`, `head`, `tail`, `width`: output folding thresholds |
| `dlog` (or legacy `dlog.json`) | `dlog` | `tail`, `width`: log tail window and line width |
| `wait` (or legacy `wait.json`) | `waitfor` | `tail`, `around`, `portTimeoutMs`: waitfor output and probe tuning |
| `hotspots` (or legacy `hotspots.json`) | `src hotspots` | `bulk`, `limit`, `months`: churn and complexity tuning |
| `guard` (or `.kaynooo/guard.json`) | `guard` | rule toggles, extra protected paths, and allowlists |
| `slot` (or legacy `slot.json`) | `slot` | default machine-wide slot count |

## Project & state files

| File | Read by | Purpose |
|---|---|---|
| `.kaynooo/theme.json` | every bin | project theme override, found upward to repository root (JSONC) |
| `.kaynooo/guard.json` | `guard` | project guard overrides, found upward to repository root |
| `.pkgrc.json` | `pkg` | project `licenses`, `blockSeverity`, `minAge`, `concurrency`, `trusted` |
| `~/.local/state/kaynooo-cli/pkg-excluded.json` | `pkg bump` | folders unchecked in the bump checklist (mutable UI state; falls back to legacy `~/.config/kaynooo-cli/pkg-excluded.json`) |
| `.npmrc`, `bunfig.toml` | `pkg` | registry and token per scope, read as `bun` reads them |
| `changelog.config.{ts,mts,js,mjs,json}`, `package.json#changelog` | `changelog` | release notes groups, Discord webhook, `baseUrl`, `provider` |

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
| `preset` | `default`, `high-contrast` (bright colours), `light` (for light terminal backgrounds), `mono` (bold, dim and underline only) or `ascii` (glyphs in plain ASCII) |
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
| `KIT_MODE` | every bin | `terminal`, `ci`, `agent` or `pipe`, forcing how the output is shaped; `CLAUDECODE`, `AI_AGENT`, `CODEX_SANDBOX`, `CODEX_CI`, `CURSOR_AGENT`, `OPENCODE`, `GEMINI_CLI` and `ANTIGRAVITY_AGENT` select `agent` |
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
| `GITHUB_TOKEN` | `changelog` | the forge's token when `--token` is not given; on GitHub, `gh auth token` comes after it |
| `DISCORD_WEBHOOK` | `changelog` | the webhook the release is posted to when `--discord-webhook` is not given |
| `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR` | `ft`, `waitfor` | where Claude Code keeps its sessions, and the temporary folder a background task writes to |

`cli config` shows which of these files this host has, and the main variables set. `<bin> <command> --help` lists each bin's flags, `bun run docs` regenerates [bins.md](bins.md).
