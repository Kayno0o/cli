import type { Issue, IssueComment } from '../src/issues'
import { describe, expect, test } from 'bun:test'
import { numberedBody } from '../src/checklist'
import { renderIssue } from '../src/commands/issue'

const NOW = Date.parse('2026-10-23T12:00:00+02:00')

const found: Issue = {
  number: 12,
  title: 'ft issue leaves out the description',
  body: '**Context:** lanes pair it with tea.\r\n\r\n**Checklist:**\r\n- [x] prints the description\r\n  - [ ] nested box\r\n- [ ] adds the comments\r\n',
  state: 'open',
  html_url: 'https://git.kaynooo.fr/kaynooo/forgejo-tools/issues/12',
  comments: 2,
  labels: [],
}

const comments: IssueComment[] = [
  { body: 'Taken by session lane-60-12.', created_at: '2026-10-23T10:00:00+02:00', user: { login: 'kaynooo' } },
  { body: 'Decisions: boxes stay in place.\r\n', created_at: '2026-10-23T11:30:00+02:00', user: { login: 'kaynooo' } },
]

describe('numberedBody', () => {
  test('numbers each box in place, keeping its indent and the lines around it', () => {
    expect(numberedBody(found.body)).toBe('**Context:** lanes pair it with tea.\n\n**Checklist:**\n1 [x] prints the description\n  2 [ ] nested box\n3 [ ] adds the comments')
  })
})

describe('renderIssue', () => {
  test('prints the header, url and numbered description, comments only when asked', () => {
    const plain = renderIssue(found, comments, { todo: false, comments: false }, NOW)

    expect(plain).toStartWith('#12 ft issue leaves out the description (open, 2 of 3 boxes left, taken by lane-60-12 2h ago)\nhttps://git.kaynooo.fr/kaynooo/forgejo-tools/issues/12\n\n**Context:**')
    expect(plain).not.toContain('---')
    expect(renderIssue(found, comments, { todo: false, comments: true }, NOW)).toEndWith('--- kaynooo, 2h ago\nTaken by session lane-60-12.\n\n--- kaynooo, 30m ago\nDecisions: boxes stay in place.')
  })

  test('prints only the header and the boxes left with --todo', () => {
    expect(renderIssue(found, [], { todo: true, comments: false }, NOW)).toBe('#12 ft issue leaves out the description (open, 2 of 3 boxes left)\n  2 [ ] nested box\n  3 [ ] adds the comments')
  })
})
