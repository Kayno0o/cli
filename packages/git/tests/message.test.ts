import { describe, expect, test } from 'bun:test'
import { BULLETS, commitMessageViolation, TITLE, TITLE_LINE, TOO_LONG, TRAILERS, WRAPPED } from '../src/message'

describe('commitMessageViolation', () => {
  const refused: [string, string, string][] = [
    ['a title that is no Conventional Commit', 'Fixed the band', TITLE],
    ['a co-author trailer', 'fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>', TRAILERS],
    ['a generated-with line', 'fix: x\n\nGenerated with Claude Code', TRAILERS],
    ['a title running over two lines', 'fix: x\nand y', TITLE_LINE],
    ['a bullet list body', 'fix: x\n\n- one\n- two', BULLETS],
    ['three body lines', 'fix: x\n\nOne.\nTwo.\nThree.', TOO_LONG],
    ['a hard-wrapped body sentence', 'fix: x\n\nKeep the band visible when the\nprompt grows.', WRAPPED],
  ]

  for (const [name, message, rule] of refused) {
    test(`refuses ${name}`, () => {
      expect(commitMessageViolation(message)).toBe(rule)
    })
  }

  const kept: [string, string][] = [
    ['a scoped title', 'feat(mods): x'],
    ['a breaking change', 'feat(api)!: x'],
    ['a body and ticket lines', 'fix(band): x\n\nKeeps the band visible.\n\n#5 - deliver every pointer\n#6 - [UC12] Afficher la liste'],
    ['two body lines and a ticket of another repository', 'fix(band): x\n\nKeeps the band visible.\nDrops the old cache.\n\nkaynooo/agent-tools#39 - guard rules live in the dotfiles mods'],
    ['two body sentences', 'fix: x\n\nKeeps the band visible.\nDrops the old cache.'],
    ['a title git writes', 'Merge branch \'x\''],
    ['a breaking change giving full details', 'feat(api)!: drop v1\n\n- one\n- two\n- three'],
    ['a breaking change footer', 'feat(api): drop v1\n\nRoutes move.\nClients break.\nBREAKING CHANGE: v1 is gone'],
    ['a title naming generated code', 'fix: types generated with openapi'],
    ['surrounding blank lines and trailing spaces', '\nfix: x  \n\n'],
  ]

  for (const [name, message] of kept) {
    test(`keeps ${name}`, () => {
      expect(commitMessageViolation(message)).toBeNull()
    })
  }
})
