import type { RawGitCommit } from '../src/changelog'
import type { Commit, ResolvedChangelogOptions } from '../src/types'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGitCommit } from '../src/changelog'
import { loadConfig } from '../src/config'
import { generateDiscordPayload } from '../src/discord'
import { headingAnchor, parseHighlights, readHighlights, resolveLinks } from '../src/highlights'
import { generateMarkdown } from '../src/markdown'

const PAGE = 'https://docs.example/guides/whats-new/'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'changelogitea-highlights-'))
})

afterAll(() => rm(dir, { recursive: true, force: true }))

async function options(overrides: Partial<ResolvedChangelogOptions> = {}) {
  return await loadConfig({ baseUrl: 'forge.example', repo: 'o/r', releaseRepo: 'o/r', from: 'v1.0.0', to: 'v1.1.0', ...overrides }, dir) as ResolvedChangelogOptions
}

function commit(message: string, hash = 'aaaaaa1'): Commit {
  const raw: RawGitCommit = { message, body: '', shortHash: hash, author: { name: 'Ada', email: 'ada@example.com' } }

  return parseGitCommit(raw, { scopeMap: {} } as never)!
}

const PAGE_SOURCE = [
  '---',
  'title: What\'s new',
  '## 1.1.0 in the frontmatter is not a heading',
  '---',
  'Each release, newest first.',
  '',
  '## Unreleased',
  '',
  '- Not out yet.',
  '',
  '## 1.1.0',
  '',
  'Two things worth knowing.',
  '',
  '### Render a page',
  '',
  '`kay render` prints a page, see [the CLI](/reference/cli#render) and [below](#more).',
  '',
  '```md',
  '## 1.0.0 inside a fence stays',
  '```',
  '',
  '## 1.0.0',
  '',
  '- Older.',
  '',
].join('\n')

describe('the section', () => {
  it('takes the lines under the version heading up to the next one, headings demoted below the highlights title and links resolved', () => {
    expect(parseHighlights(PAGE_SOURCE, '1.1.0', PAGE)).toEqual({
      lines: [
        'Two things worth knowing.',
        '',
        '#### Render a page',
        '',
        '`kay render` prints a page, see [the CLI](https://docs.example/reference/cli#render) and [below](https://docs.example/guides/whats-new/#more).',
        '',
        '```md',
        '## 1.0.0 inside a fence stays',
        '```',
      ],
      link: 'https://docs.example/guides/whats-new/#110',
    })
  })

  it('is nothing for a version the file has no section for, or an empty one', () => {
    expect(parseHighlights(PAGE_SOURCE, '2.0.0', PAGE)).toBeUndefined()
    expect(parseHighlights('## 2.0.0\n\n## 1.0.0\n- a', '2.0.0', PAGE)).toBeUndefined()
  })

  it('skips the frontmatter, so a heading written in it is not a section', () => {
    expect(parseHighlights('---\n## 3.0.0\n---\n## 1.0.0\n- a', '3.0.0', PAGE)).toBeUndefined()
    expect(parseHighlights('---\n## 3.0.0\n--- \n## 1.0.0\n- a', '3.0.0', PAGE)).toBeUndefined()
  })

  it('reads the version off the tag through the tag template, and nothing for a missing file', async () => {
    await writeFile(join(dir, 'whats-new.md'), PAGE_SOURCE)

    expect((await readHighlights(await options({ highlights: { file: 'whats-new.md', url: PAGE } }), dir))?.link).toBe('https://docs.example/guides/whats-new/#110')
    expect(await readHighlights(await options({ highlights: { file: 'whats-new.md', url: PAGE }, to: 'release-1.1.0', tag: 'release-%s' }), dir)).toBeDefined()
    expect(await readHighlights(await options({ highlights: { file: 'missing.md', url: PAGE } }), dir)).toBeUndefined()
    expect(await readHighlights(await options(), dir)).toBeUndefined()
  })
})

describe('links', () => {
  it('resolves root-relative and relative targets against the page, and leaves absolute ones, anchors elsewhere and code spans alone', () => {
    expect(resolveLinks('[a](/x/y#z) [b](sibling/) [c](https://other.example/p) [d](mailto:a@b.c) ![e](/img.png "Title") `[f](/in-code)`', PAGE)).toBe(
      '[a](https://docs.example/x/y#z) [b](https://docs.example/guides/whats-new/sibling/) [c](https://other.example/p) [d](mailto:a@b.c) ![e](https://docs.example/img.png "Title") `[f](/in-code)`',
    )
  })

  it('resolves a reference definition', () => {
    expect(resolveLinks('[cli]: /reference/cli', PAGE)).toBe('[cli]: https://docs.example/reference/cli')
  })
})

describe('anchors', () => {
  it('slugs a heading as GitHub and Bun.markdown do', () => {
    expect(headingAnchor('1.44.0')).toBe('1440')
    expect(headingAnchor('What\'s New in 2.0')).toBe('whats-new-in-20')
  })
})

describe('notes', () => {
  const highlights = { lines: ['Two things.', '', '#### Render', '- `kay render`'], link: `${PAGE}#110` }

  it('open the release body with the highlights and a link to the page', async () => {
    const md = generateMarkdown([commit('feat: a')], await options(), [], highlights)

    expect(md).toContain([
      '',
      '### 🌟 Highlights',
      '',
      'Two things.',
      '',
      '#### Render',
      '- `kay render`',
      '',
      `[Read more](${PAGE}#110)`,
      '',
      '### ✨ New',
    ].join('\n'))
    expect(md.indexOf('Highlights')).toBeLessThan(md.indexOf('✨ New'))
  })

  it('are as before without highlights', async () => {
    const opts = await options()

    expect(generateMarkdown([commit('feat: a')], opts, [], undefined)).toBe(generateMarkdown([commit('feat: a')], opts))
  })

  it('open the Discord post with the highlights, headings in bold', async () => {
    const embed = generateDiscordPayload([commit('feat: a')], await options(), [], highlights).embeds![0]!

    expect(embed.description).toStartWith([
      '**🌟 Highlights**',
      'Two things.',
      '',
      '**Render**',
      '- `kay render`',
      `[Read more](${PAGE}#110)`,
      '',
      '**✨ New**',
    ].join('\n'))
  })

  it('close a code block cut open on Discord with its own marker', async () => {
    const commits = Array.from({ length: 40 }, (_, i) => commit(`feat: ${'long change '.repeat(6)}${i}`, `a${String(i).padStart(6, '0')}`))
    const long = { lines: ['~~~~sh', ...Array.from({ length: 200 }, (_, i) => `echo ${'word '.repeat(6)}${i}`), '~~~~'], link: `${PAGE}#110` }
    const description = generateDiscordPayload(commits, await options(), [], long).embeds![0]!.description!

    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description).toContain(`~~~~\n…\n[Read more](${PAGE}#110)`)
  })

  it('cut on Discord at a line, commits first, then the highlights, the link to the page kept', async () => {
    const commits = Array.from({ length: 40 }, (_, i) => commit(`feat: ${'long change '.repeat(6)}${i}`, `a${String(i).padStart(6, '0')}`))
    const long = { lines: Array.from({ length: 200 }, (_, i) => `- highlight ${'word '.repeat(6)}${i}`), link: `${PAGE}#110` }
    const embed = generateDiscordPayload(commits, await options(), [], long).embeds![0]!
    const description = embed.description!

    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description).toContain(`[Read more](${PAGE}#110)`)
    expect(description).not.toContain('**✨ New**')
    expect(description).toContain('*…and 40 more*')
    expect(description.split('\n').every(line => line === '' || line.startsWith('- highlight') || line.startsWith('**') || line.startsWith('*…') || line.startsWith('[') || line.startsWith('…'))).toBe(true)
  })
})
