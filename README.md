# @kaynooo/changelogitea

Generate changelog for Gitea / Forgejo releases from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), powered by [changelogen](https://github.com/unjs/changelogen).

> **Bun only.** This tool runs on [Bun](https://bun.sh) and uses Bun-native APIs (`Bun.$`, `Bun.file`, `Bun.Glob`, global `fetch`). It is not meant to run under Node.

## Features

- Support exclamation mark as breaking change, e.g. `chore!: drop node v10`
- Grouped scope in changelog
- Create the release note, or update the existing one
- List contributors
- Upload assets to the release

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

      - run: bunx @kaynooo/changelogitea
        env:
          GITHUB_TOKEN: ${{secrets.GITHUB_TOKEN}}
```

It will be triggered whenever you push a tag that starts with `v`.

The package is published to the Forgejo npm registry. To install it from there, add to your `.npmrc`:

```ini
@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/
```

## Configuration

You can put a configuration file in the project root, named as `@kaynooo/changelogitea.config.{json,ts,js,mjs,cjs}`, `.changelogitearc` or use the `changelogitea` field in `package.json`.

### Roll up patches into minor releases

If you cut several patches between minor releases, `rollup` makes a minor (or major) note list every commit since the previous minor (or major), instead of only since the last patch:

```ts
// @kaynooo/changelogitea.config.ts
import { defineConfig } from '@kaynooo/changelogitea'

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

## Preview Locally

```bash
bunx @kaynooo/changelogitea --dry
```

## Undo a Release

Rolled a bad release? `undo` deletes the remote tag, the local tag, and soft-resets the version-bump commit (changes are kept in your working tree). The commit is only reset when the tag points at `HEAD`.

```bash
bunx @kaynooo/changelogitea undo v1.4.2
```

The Gitea release note is **not** removed by default - you're asked about it interactively. Pass `--note` to include it non-interactively.

| Flag     | Description                                             |
| -------- | ------------------------------------------------------- |
| `--note` | Also delete the Gitea release note (skips the question) |
| `--dry`  | Preview what would be removed, without deleting         |
| `--yes`  | Skip confirmation prompts (for CI/scripts)              |

## Why?

I used to use [`conventional-github-releaser`](https://github.com/conventional-changelog/releaser-tools/tree/master/packages/conventional-github-releaser) for almost all my projects. Until I found that it [does NOT support using exclamation marks for breaking changes](https://github.com/conventional-changelog/conventional-changelog/issues/648) - hiding those important breaking changes in the changelog without the awareness from maintainers.

## Credits

This is a Gitea / Forgejo port of [`changelogithub`](https://github.com/antfu/changelogithub) by [Anthony Fu](https://github.com/antfu).

## License

[MIT](./LICENSE) License © 2022 [Anthony Fu](https://github.com/antfu)
