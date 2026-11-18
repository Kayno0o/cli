# page

A page's layout defects measured in a browser, one line each, for Claude Code checking UI work it would otherwise judge from screenshots alone; and a built page diffed against its mockup.

```sh
bun install -g @kaynooo/cli-page
```

## Commands

| Command | What it does |
| --- | --- |
| `page check <file\|url>...` | shoots each target full-page at every width, prints the PNG paths, then one `<target> <width>px <kind> <selector>: <measure>` line per defect |
| `page diff <mockup> <built>` | shoots both at every width and writes `<name>-side-<width>.png` (mockup left, built right) and `<name>-diff-<width>.png` (built faded, differing pixels red), the differing regions boxed and numbered on both and printed one line each |
| `page shift <before> <after>` | pairs both pages' elements at every width and prints one line per cause of a change, `<after> <width>px <kind> <selector>: <change>, pushing <n> elements` |

Targets are HTML files (a path or a `file://` URL, `#fragment` kept) or URLs already served: `page` never starts or builds an app. The widths are 1440 and 400 unless `-w 1280,768,375` says otherwise. PNGs go next to a file, into `-o <dir>`, or under `~/.cache/kaynooo-page` for a URL.

A page behind a login takes `--cookie name=value`, `-H "Authorization: Bearer <token>"` (sent to the target's origin only, never to the third-party scripts and fonts it loads) or `--storage-state <file>`, a Playwright storage state with cookies and localStorage. Both commands take them; a malformed value is refused without being echoed.

What `check` reports:

- `redirect`: the page landed on another URL, a login page say, so every other line is about that page. `diff` says so on stderr instead.
- `overflow`: the page scrolls sideways; the up to three elements where it starts, with their right edge.
- `console`: console errors and uncaught exceptions. `request`: requests that failed or answered 4xx/5xx. Both once per target, at the first width they show at.
- `font`: text drawn in another font than its `font-family` asks for, naming the font Chromium drew it with (CDP `CSS.getPlatformFontsForNode`): a named family that is not available, or a generic one such as `system-ui` resolving to a monospace font.
- `contrast`: text under WCAG AA, 4.5:1 or 3:1 for large text, with both colours and the ratio (measured by `@kaynooo/audit-engine`); text over an image, a gradient or a filter cannot be measured and is left out.
- `tap-target`: a control under 44px wide or tall below 600px wide, under 24px otherwise; a link inside a sentence is exempt, a checkbox counts its label.
- `padding`: text touching an edge its box draws, a border side or a background unlike what is behind it.
- `wrap`: a word broken between two letters or digits, such as a label squeezed to one letter per line or a hostname ending on a line of its own, shown with `|` where it breaks; a break after a hyphen or slash is left alone.
- `image`: an image that finished loading with nothing to draw. `layout-shift`: a cumulative layout shift score above 0.1, naming the element that moved most.

`--skip font,padding` leaves kinds out, `--json` prints `{shots, findings, failed}`. `diff` counts a pixel as different when a channel moves by more than `--threshold` (32 of 255) and ignores a lone differing pixel in an 8px cell.

What `shift` reports: `resized` with both sizes, `padding` (padding or border changed, size kept), `moved` (a margin say), `added` and `removed`. An element keeping its offset from its parent's content box or its gap to its previous sibling was pushed, so it gets no line and counts in the cause it follows; neither does a box resized by what changed inside it, or one whose width follows its parent's. A header grown 10px is one line, not one per element below it. Elements pair by id, then by tag with their text or accessible name, then by that text alone, when unique on both pages, then by tag in order under parents already paired: two builds of one page pair throughout, and a mockup against the built app pairs on its headings, labels and buttons, the rest showing up as added and removed.

Chromium is never downloaded: `PAGE_CHROMIUM` when set, else the newest full build under `~/.cache/ms-playwright` (then its headless shell, which resolves fonts unlike a desktop browser), else `/usr/bin/chromium`, `chromium-browser`, `google-chrome-stable` or `brave`.

Both commands exit 0 when nothing is found and 1 when something is; `check` exits 2 on a usage error or a target that would not load, `diff` and `shift` 1 on a page that would not load and 2 on a usage error.
