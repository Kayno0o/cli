import { describe, expect, test } from 'bun:test'
import { diffTexts } from '../src/diff'

describe('diffTexts', () => {
  test('labels the unified diff with the path and counts added and removed lines', async () => {
    const diff = await diffTexts('src/x.ts', 'a\nb\nc\n', 'a\nB\nc\nd\n')

    expect(diff.unified).toContain('--- a/src/x.ts')
    expect(diff.unified).toContain('+++ b/src/x.ts')
    expect(diff).toMatchObject({ added: 2, removed: 1 })
  })

  test('is empty for identical texts', async () => {
    expect(await diffTexts('x', 'same\n', 'same\n')).toEqual({ unified: '', added: 0, removed: 0 })
  })

  test('a removed line starting with dashes still counts as removed', async () => {
    expect(await diffTexts('x', '--flag\nkeep\n', 'keep\n')).toMatchObject({ added: 0, removed: 1 })
  })
})
