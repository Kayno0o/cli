import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { binsMarkdown } from '../scripts/bins-docs'

test('docs/bins.md is up to date, regenerate it with `bun run docs`', () => {
  expect(readFileSync(new URL('../docs/bins.md', import.meta.url), 'utf8')).toBe(binsMarkdown())
})
