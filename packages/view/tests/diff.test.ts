import { describe, expect, test } from 'bun:test'
import { looksLikeDiff, renderDiff } from '../src/diff'
import { themeFor } from '../src/theme'

const colour = themeFor({ isTTY: true }, {})
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\nindex e01ae4d..ad34e3f 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@ function f()\n keep\n--- a comment line\n+++ not a header\n\\ No newline at end of file\n'

describe('looksLikeDiff', () => {
  test('recognises a diff, a log with patches and a hunk by the first line', () => {
    expect(looksLikeDiff(DIFF)).toBe(true)
    expect(looksLikeDiff('\ncommit 2e46285273c24709d60857703e5d8e603bebda1a\nAuthor: a')).toBe(true)
    expect(looksLikeDiff('@@ -1 +1 @@\n-a\n+b')).toBe(true)
    expect(looksLikeDiff('\u001B[1mdiff --git a/x b/x\u001B[m')).toBe(true)
    expect(looksLikeDiff('# Title\n\ntext')).toBe(false)
  })
})

describe('renderDiff', () => {
  test('keeps every line, whatever the colour', () => {
    expect(Bun.stripANSI(renderDiff(DIFF, colour))).toBe(DIFF.replace('diff --git a/src/a.ts b/src/a.ts', 'diff src/a.ts'))
  })

  test('colours added and removed lines, and tells a hunk\'s `---` content from a file header', () => {
    const lines = renderDiff(DIFF, colour).split('\n')

    expect(lines[2]).toBe('\u001B[2m--- a/src/a.ts\u001B[22m')
    expect(lines[5]).toBe(' keep')
    expect(lines[6]).toBe('\u001B[31m--- a comment line\u001B[39m')
    expect(lines[7]).toBe('\u001B[32m+++ not a header\u001B[39m')
    expect(lines[8]).toContain('\u001B[2m')
  })

  test('colours a hunk range apart from the context after it, and a commit id', () => {
    expect(renderDiff('@@ -1 +1 @@ ctx\n-a\n+b\n', colour).split('\n').at(0)).toBe('\u001B[36m@@ -1 +1 @@\u001B[39m\u001B[2m ctx\u001B[22m')
    expect(renderDiff('commit abcdef1234\n', colour)).toBe('\u001B[2mcommit \u001B[22m\u001B[33mabcdef1234\u001B[39m\u001B[2m\u001B[22m\n')
  })

  test('counts a hunk without a length as one line', () => {
    expect(renderDiff('@@ -3 +3 @@\n-a\n+b\n--- next', colour).split('\n')[3]).toBe('\u001B[2m--- next\u001B[22m')
  })
})
