import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { capture } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dispatch } from '../src/commands/dispatch'
import { teaLogins } from '../src/forge'
import { close, comment, createIssue, editIssue, editLabels, getIssue, reopen } from '../src/issues'
import { refusal, withFakeGt } from './fake-tea'

const TOKEN = 'secret-token-0123456789'
const root = mkdtempSync(join(tmpdir(), 'ft-gt-'))
const saved = { cwd: process.cwd(), config: process.env.XDG_CONFIG_HOME, token: process.env.GITEA_TOKEN, host: process.env.GITEA_CLI_HOST }

function restore(name: string, value: string | undefined): void {
  if (value === undefined)
    Reflect.deleteProperty(process.env, name)
  else
    process.env[name] = value
}

// Run from a repository on the logged-in forge, whatever forge this checkout's own origin is on.
beforeAll(async () => {
  mkdirSync(join(root, 'tea'), { recursive: true })
  writeFileSync(join(root, 'tea', 'config.yml'), `logins:\n    - name: git.kaynooo.fr\n      url: https://git.kaynooo.fr\n      token: ${TOKEN}\n      default: true\n      user: kaynooo\n`)
  process.env.XDG_CONFIG_HOME = root
  await $`git init -q repo && git -C repo remote add origin git@git.kaynooo.fr:kaynooo/cli.git`.cwd(root).quiet()
  process.chdir(join(root, 'repo'))
})

afterAll(() => {
  process.chdir(saved.cwd)
  restore('XDG_CONFIG_HOME', saved.config)
  rmSync(root, { recursive: true, force: true })
})

// Every test starts without a token, as the injection is only for a caller with none.
function clean(): void {
  Reflect.deleteProperty(process.env, 'GITEA_TOKEN')
  Reflect.deleteProperty(process.env, 'GITEA_CLI_HOST')
}

function initial() {
  return {
    issues: [{ number: 4, title: 'old', body: 'text', state: 'open', labels: [{ name: 'bug' }] }],
    labels: ['bug', 'ui', 'kind/chore'],
    milestones: [{ id: 7, title: 'v1', state: 'open' }],
  }
}

describe('teaLogins', () => {
  test('reads the url, token and default flag of each login', () => {
    expect(teaLogins(`logins:\n    - name: a\n      url: "https://a.example"\n      token: t1\n      default: false\n    - name: b\n      url: https://b.example\n      token: t2\n      default: true\npreferences:\n    editor: false\n`)).toEqual([
      { url: 'https://a.example', token: 't1', isDefault: false },
      { url: 'https://b.example', token: 't2', isDefault: true },
    ])
  })
})

describe('ft with gt and no tea', () => {
  test('reads through gt api with the token and host of tea\'s config', async () => {
    clean()

    const state = await withFakeGt(initial(), async () => {
      expect((await getIssue(4)).title).toBe('old')
    })

    expect(state.seen).toEqual([{ token: TOKEN, host: 'https://git.kaynooo.fr' }])
    clean()
  })

  test('keeps a token the caller already set', async () => {
    process.env.GITEA_TOKEN = 'mine'
    process.env.GITEA_CLI_HOST = 'https://other.example'

    const state = await withFakeGt(initial(), async () => {
      await getIssue(4)
    })

    expect(state.seen).toEqual([{ token: 'mine', host: 'https://other.example' }])
    clean()
  })

  test('posts a comment', async () => {
    clean()

    const state = await withFakeGt(initial(), async () => {
      await comment(4, '- starts with a dash')
    })

    expect(state.comments?.[4]).toEqual(['- starts with a dash'])
    clean()
  })

  test('creates, edits, closes and reopens an issue through the API, labels and milestone by name', async () => {
    clean()

    const state = await withFakeGt(initial(), async () => {
      const created = await createIssue('New', 'body', 'ui,kind/chore', 'v1')

      expect(created.number).toBe(5)
      await editIssue(5, { title: 'Renamed', body: 'changed', milestone: '' })
      await editLabels(4, ['ui'], ['bug'])
      await close(4)
      await close(5)
      await reopen(5)
    })

    expect(state.issues[1]).toMatchObject({ number: 5, title: 'Renamed', body: 'changed', state: 'open', milestone: null, labels: [{ name: 'ui' }, { name: 'kind/chore' }] })
    expect(state.issues[0]).toMatchObject({ state: 'closed', labels: [{ name: 'ui' }] })
    expect(state.calls?.every(call => call[0] === 'api')).toBe(true)
    clean()
  })

  test('sets a milestone by title', async () => {
    clean()

    const state = await withFakeGt(initial(), async () => {
      await editIssue(4, { milestone: 'v1' })
    })

    expect(state.issues[0]?.milestone).toMatchObject({ id: 7 })
    clean()
  })

  test('surfaces the API error message, never the token', async () => {
    clean()

    let message = ''

    await withFakeGt({ ...initial(), failures: [{ match: 'issues/4', message: `denied for ${TOKEN}`, times: 1 }] }, async () => {
      message = await refusal(getIssue(4))
    })

    expect(message).toContain('gt api')
    expect(message).toContain('denied for ***')
    expect(message).not.toContain(TOKEN)
    clean()

    await withFakeGt(initial(), async () => {
      message = await refusal(getIssue(99))
    })

    expect(message).toContain('not found')
    clean()
  })

  test('ft dispatch starts a run through gt with tea\'s token, and a refusal never prints it', async () => {
    clean()

    let message = ''
    const state = await withFakeGt({ ...initial(), workflows: ['apps.yml'] }, async () => {
      await capture(async () => dispatch(['apps.yml']))
    })

    expect(state.runs?.[0]).toMatchObject({ workflow_id: 'apps.yml', event: 'workflow_dispatch' })
    expect(state.seen?.[0]).toEqual({ token: TOKEN, host: 'https://git.kaynooo.fr' })
    clean()

    await withFakeGt({ ...initial(), workflows: ['apps.yml'], failures: [{ match: 'dispatches', message: `denied for ${TOKEN}` }] }, async () => {
      message = await refusal(dispatch(['apps.yml', '--ref', 'main']))
    })

    expect(message).toContain('denied for ***')
    expect(message).not.toContain(TOKEN)
    clean()
  })

  test('an unknown label is refused by name', async () => {
    clean()

    await withFakeGt(initial(), async () => {
      expect(await refusal(createIssue('x', '', 'nope', undefined))).toContain('no label nope')
    })

    clean()
  })
})
