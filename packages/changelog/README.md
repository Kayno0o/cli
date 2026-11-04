# @kaynooo/cli-changelog

Generate changelog for Gitea / Forgejo releases from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), and post it to Discord.

> **Bun only.** This tool runs on [Bun](https://bun.sh) and uses Bun-native APIs (`Bun.$`, `Bun.file`, `Bun.Glob`, global `fetch`). It is not meant to run under Node.

## Features

- Support exclamation mark as breaking change, e.g. `chore!: drop node v10`
- Grouped scope in changelog
- Issues linked from the subject (`#12`) and from `#12 - title` lines in the commit body
- Create the release note, or update the existing one
- Post the release to a Discord webhook
- Open the notes with the release's section of a hand-written "what's new" page
- List contributors with their avatars
- Upload assets to the release

## Format

A note opens with a one-line summary (`3 new · 3 fixed · 6 maintenance · by @kaynooo · v1.5.0 → v1.6.6`), then lists:

- **⚠️ Breaking**, **✨ New**, **🔧 Fixed** and **⚡ Faster**, each line ending with its commit and issue links
- refactor, docs, build, types, test, style and ci commits folded into one collapsed **🧹 Maintenance** block
- the contributors' avatars and a link to the full diff

A type set to `{ title, folded: true }` in `types` joins the maintenance block, and `titles.maintenance` renames it.

With [`highlights`](#open-the-notes-with-highlights), a **🌟 Highlights** section comes right after the summary.

## Discord

Once the release is out on Forgejo, it is posted to the webhook in `DISCORD_WEBHOOK` (or `discordWebhook` / `--discord-webhook`) as one embed: the same sections with each issue's title beside it, maintenance as a count line, and links to the full note and the diff. A note too long for Discord's 4096 characters ends with `…and N more`. Nothing is posted when no webhook is set.

```yml
      - run: bunx @kaynooo/cli-changelog
        env:
          GITHUB_TOKEN: ${{secrets.GITHUB_TOKEN}}
          DISCORD_WEBHOOK: ${{secrets.DISCORD_WEBHOOK}}
```

## Usage

In Gitea / Forgejo Actions:

```yml
# .gitea/workflows/release.yml

name: Release

permissions:
  contents: write

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bunx @kaynooo/cli-changelog
        env:
          GITHUB_TOKEN: ${{secrets.GITHUB_TOKEN}}
```

It will be triggered whenever you push a tag that starts with `v`.

The package is published to the Forgejo npm registry. To install it from there, add to your `.npmrc`:

```ini
@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/
```

## Configuration

Put a `changelog.config.{ts,mts,js,mjs,json}` file in the project root, or a `changelog` field in `package.json`. CLI flags override the file, which overrides `package.json`.

### Roll up patches into minor releases

If you cut several patches between minor releases, `rollup` makes a minor (or major) note list every commit since the previous minor (or major), instead of only since the last patch:

```ts
// changelog.config.ts
import { defineConfig } from '@kaynooo/cli-changelog'

export default defineConfig({
  rollup: {
    // On a `x.y.0` release, start from the previous `x.(y-1).0` tag,
    // absorbing every patch in between.
    minor: true,
    // On a `x.0.0` release, start from the previous `(x-1).0.0` tag,
    // absorbing every minor and patch in between.
    major: true,
  },
})
```

Both default to `false`.

### Follow only the first parent

After a `git merge --allow-unrelated-histories` (or any big merge), the note would list every commit the merge brought in. `firstParent` walks only the first parent of each merge, so the merge shows as itself:

```ts
// changelog.config.ts
import { defineConfig } from '@kaynooo/cli-changelog'

export default defineConfig({
  firstParent: true,
})
```

It defaults to `false`. The tag the range starts from and the first commit are also looked up along the first parent.

This also drops the commits of a feature branch merged with a merge commit: only the merge's own message is read. It suits repos that squash or fast-forward, plus a one-off import.

### Open the notes with highlights

Commit lines say what changed, not why it matters. `highlights` points at a Markdown page you write by hand, one `## <version>` section per release, and opens the notes with the section of the version being released, under **🌟 Highlights**, ending on a link to it:

```ts
// changelog.config.ts
import { defineConfig } from '@kaynooo/cli-changelog'

export default defineConfig({
  highlights: {
    file: 'docs/whats-new.md',
    url: 'https://docs.example.com/whats-new/',
  },
})
```

```md
## 1.4.0

- `render` prints a page without a server: see [the CLI](/reference/cli#render).
```

- The section is found by the version without the tag's prefix: `## 1.4.0` for `v1.4.0`. It runs to the next `## ` heading; its own headings are demoted one level, and the page's frontmatter is skipped.
- Links resolve against `url`, so `/reference/cli` becomes `https://docs.example.com/reference/cli`. When the site serves a page elsewhere than its file, `link` maps each target as written before it resolves, `undefined` keeping it: `link: target => target.replace(/\.md(?=#|$)/, '')` turns `cli.md#render` into `cli#render`. The closing link goes to the version's heading on the page, slugged as GitHub does (`#140`).
- The Discord post opens with the same section, its headings in bold. When the post runs past Discord's limit, commits are dropped first, then the section's last lines, the link to the page always kept.
- Without the file or a section for the version, the notes are as they would be without the option. `titles.highlights` renames the section.

## Preview Locally

```bash
bunx @kaynooo/cli-changelog --dry-run
```

## Undo a Release

Rolled a bad release? `undo` deletes the remote tag, the local tag, and soft-resets the version-bump commit (changes are kept in your working tree). The commit is only reset when the tag points at `HEAD`.

```bash
bunx @kaynooo/cli-changelog undo v1.4.2
```

The tag is optional - omit it to undo the latest tag (you'll be warned which one):

```bash
bunx @kaynooo/cli-changelog undo
```

The Gitea release note is **not** removed by default - you're asked about it interactively. Pass `--note` to include it non-interactively.

| Flag     | Description                                             |
| -------- | ------------------------------------------------------- |
| `--note` | Also delete the Gitea release note (skips the question) |
| `--dry-run` | Preview what would be removed, without deleting         |
| `--yes`  | Skip confirmation prompts (for CI/scripts)              |

## Why?

I used to use [`conventional-github-releaser`](https://github.com/conventional-changelog/releaser-tools/tree/master/packages/conventional-github-releaser) for almost all my projects. Until I found that it [does NOT support using exclamation marks for breaking changes](https://github.com/conventional-changelog/conventional-changelog/issues/648) - hiding those important breaking changes in the changelog without the awareness from maintainers.

## Credits

This is a Gitea / Forgejo port of [`changelogithub`](https://github.com/antfu/changelogithub) by [Anthony Fu](https://github.com/antfu).

## License

[MIT](./LICENSE) License © 2022 [Anthony Fu](https://github.com/antfu)
