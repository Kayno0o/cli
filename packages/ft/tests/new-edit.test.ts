import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { edit, issue, newIssue } from '../src/commands/issue'
import { refusal, withFakeTea } from './fake-tea'

const BODY = 'Uses `tea` and $HOME, "quoted".\r\n\r\n- [ ] one\r\n'

async function withFile(text: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ft-body-'))

  try {
    await Bun.write(join(dir, 'body.md'), text)
    await run(join(dir, 'body.md'))
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('ft new', () => {
  test('creates an issue from a file with its labels and prints its number and url', async () => {
    const lines: string[] = []
    const log = console.log

    await withFile(BODY, async (path) => {
      const state = await withFakeTea({ issues: [{ number: 4, title: 'old', body: '', state: 'open' }], labels: ['bug', 'ui'] }, async () => {
        console.log = (line: string) => lines.push(line)

        try {
          expect(await newIssue(['-t', 'A new one', '-F', path, '-L', 'bug,ui'])).toBe(0)
        }
        finally {
          console.log = log
        }
      })

      expect(state.issues[1]).toMatchObject({ number: 5, title: 'A new one', body: BODY.trim(), labels: [{ name: 'bug' }, { name: 'ui' }] })
    })

    expect(lines).toEqual(['#5 https://forge/issues/5'])
  })

  test('needs a title', async () => {
    expect(await refusal(newIssue([]))).toContain('title')
  })
})

describe('ft edit', () => {
  test('replaces the title and the description, each alone or together', async () => {
    await withFile('# New body\n\n- [ ] x `$y`', async (path) => {
      const state = await withFakeTea({ issues: [{ number: 6, title: 'old', body: 'old body', state: 'open' }] }, async () => {
        expect(await edit(['6', '-t', 'Renamed'])).toBe(0)
        expect(await edit(['6', '-F', path])).toBe(0)
      })

      expect(state.issues[0]).toMatchObject({ title: 'Renamed', body: '# New body\n\n- [ ] x `$y`' })
    })

    expect(await refusal(edit(['6']))).toContain('nothing to change: give -t, -F, --add-box or -m')
  })

  test('-F with --add-box and no --append writes the text, then adds the boxes', async () => {
    await withFile('# New body', async (path) => {
      const state = await withFakeTea({ issues: [{ number: 6, title: 't', body: 'old', state: 'open' }] }, async () => {
        expect(await edit(['6', '-F', path, '--add-box', 'x'])).toBe(0)
      })

      expect(state.issues[0]?.body).toBe('# New body\n\n- [ ] x')
    })
  })
})

describe('ft issue --body', () => {
  test('prints the raw description with unix line ends', async () => {
    const lines: string[] = []
    const log = console.log

    await withFakeTea({ issues: [{ number: 6, title: 't', body: BODY, state: 'open' }] }, async () => {
      console.log = (line: string) => lines.push(line)

      try {
        expect(await issue(['6', '--body'])).toBe(0)
      }
      finally {
        console.log = log
      }
    })

    expect(lines).toEqual(['Uses `tea` and $HOME, "quoted".\n\n- [ ] one\n'])
  })
})

describe('ft issue --open', () => {
  test('hands the issue url to the browser command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ft-open-'))
    const log = join(dir, 'opened')
    const browser = join(dir, 'browser')
    const before = process.env.BROWSER
    const print = console.log

    writeFileSync(browser, `#!/bin/sh\necho "$1" >> ${log}\n`, { mode: 0o755 })

    await withFakeTea({ issues: [{ number: 6, title: 't', body: 'x', state: 'open' }] }, async () => {
      process.env.BROWSER = browser
      console.log = () => undefined

      try {
        expect(await issue(['6', '--open'])).toBe(0)
      }
      finally {
        console.log = print

        if (before === undefined)
          delete process.env.BROWSER
        else
          process.env.BROWSER = before
      }
    })

    await Bun.sleep(300)

    expect(readFileSync(log, 'utf8')).toBe('https://forge/issues/6\n')
    rmSync(dir, { recursive: true })
  })
})
