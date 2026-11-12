import { describe, expect, test } from 'bun:test'
import { appendBoxes } from '../src/checklist'
import { edit, newIssue } from '../src/commands/issue'
import { closeIssues, label, reopenIssues } from '../src/commands/triage'
import { refusal, withFakeTea } from './fake-tea'

async function quietly(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const log = console.log

  console.log = (line: string) => lines.push(line)

  try {
    await run()
  }
  finally {
    console.log = log
  }

  return lines
}

describe('appendBoxes', () => {
  test('adds boxes after the last one, indented like it', () => {
    expect(appendBoxes('Intro\n\n- [ ] a\n  - [x] b\n\n## Verify\nrun it', ['c', 'd'])).toBe('Intro\n\n- [ ] a\n  - [x] b\n  - [ ] c\n  - [ ] d\n\n## Verify\nrun it')
  })

  test('starts a list at the end of a body without boxes, keeping CRLF', () => {
    expect(appendBoxes('Intro\r\n', ['a'])).toBe('Intro\r\n\r\n- [ ] a\r\n')
    expect(appendBoxes('', ['a', 'b'])).toBe('- [ ] a\n- [ ] b')
  })

  test('adds after the notes under the last box, not between them', () => {
    expect(appendBoxes('- [ ] b\n  detail\n', ['c'])).toBe('- [ ] b\n  detail\n- [ ] c\n')
    expect(appendBoxes('- [ ] b\n  detail\n\n  more\n\nTail', ['c'])).toBe('- [ ] b\n  detail\n\n  more\n- [ ] c\n\nTail')
  })

  test('writes CRLF throughout on a CRLF body without a final line end', () => {
    expect(appendBoxes('- [ ] b\r\n  detail', ['c'])).toBe('- [ ] b\r\n  detail\r\n- [ ] c')
  })

  test('leaves the endings of the lines already there as they were', () => {
    expect(appendBoxes('Intro\n- [ ] b\r\nTail\n', ['c'])).toBe('Intro\n- [ ] b\r\n- [ ] c\r\nTail\n')
  })
})

describe('ft edit --append and --add-box', () => {
  test('add to the description without replacing it', async () => {
    const state = await withFakeTea({ issues: [{ number: 3, title: 't', body: 'Body\n\n- [ ] one\n\nTail', state: 'open' }] }, async () => {
      expect(await edit(['3', '--add-box', 'two', '--add-box', 'three'])).toBe(0)
    })

    expect(state.issues[0]?.body).toBe('Body\n\n- [ ] one\n- [ ] two\n- [ ] three\n\nTail')
  })

  test('--append needs -F', async () => {
    expect(await refusal(edit(['3', '--append']))).toContain('--append adds the -F text')
  })
})

describe('ft new labels', () => {
  test('refuses a label the repository lacks before creating anything', async () => {
    let message = ''
    const state = await withFakeTea({ issues: [], labels: ['bug', 'ui'] }, async () => {
      message = await refusal(newIssue(['-t', 'x', '-L', 'bug,nope']))
    })

    expect(message).toBe('no label nope in this repository, it has: bug, ui')
    expect(state.issues).toEqual([])
  })
})

describe('ft close and reopen', () => {
  test('post the reason, change the state and skip an issue already there', async () => {
    let lines: string[] = []
    const state = await withFakeTea({ issues: [{ number: 1, title: 'a', body: '', state: 'open' }, { number: 2, title: 'b', body: '', state: 'closed' }] }, async () => {
      lines = await quietly(async () => closeIssues(['1', '#2', '-m', 'duplicate of #9']))
    })

    expect(lines).toEqual(['closed #1', '#2 is already closed'])
    expect(state.issues.map(issue => issue.state)).toEqual(['closed', 'closed'])
    expect(state.comments).toEqual({ 1: ['duplicate of #9'] })

    const reopened = await withFakeTea(state, async () => {
      lines = await quietly(async () => reopenIssues(['2']))
    })

    expect(lines).toEqual(['reopened #2'])
    expect(reopened.issues[1]?.state).toBe('open')
  })
})

describe('ft label', () => {
  test('adds bare and + names, removes - names, and prints the labels', async () => {
    let lines: string[] = []
    const state = await withFakeTea({ issues: [{ number: 4, title: 't', body: '', state: 'open', labels: [{ name: 'bug' }] }], labels: ['bug', 'ui', 'kind/feature'] }, async () => {
      lines = await quietly(async () => label(['4', 'ui', '+kind/feature', '-bug']))
    })

    expect(lines).toEqual(['#4 labels: ui, kind/feature'])
    expect(state.calls?.at(-2)).toEqual(['issues', 'edit', '4', '--add-labels', 'ui,kind/feature', '--remove-labels', 'bug'])
  })

  test('refuses an unknown label, a label both added and removed, and no change', async () => {
    await withFakeTea({ issues: [{ number: 4, title: 't', body: '', state: 'open' }], labels: ['bug'] }, async () => {
      expect(await refusal(label(['4', '+nope']))).toContain('no label nope')
      expect(await refusal(label(['4', '+bug', '-bug']))).toContain('bug is both added and removed')
      expect(await refusal(label(['4']))).toContain('name labels to add or remove')
    })
  })
})
