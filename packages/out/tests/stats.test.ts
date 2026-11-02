import type { Entry } from '../src/stats'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { filtered } from '../src/stages'
import { commandKey, readEntries, record, renderSummary, summarize } from '../src/stats'

const dir = mkdtempSync(join(tmpdir(), 'out-stats-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TEXT = `${Array.from({ length: 30 }, (_, index) => `line ${index + 1}${index === 14 ? ' FAIL here' : ''}`).join('\n')}\n`

describe('filtered', () => {
  test('gives what tail and head would print', () => {
    expect(filtered(TEXT, ['tail -n 2'])).toBe('line 29\nline 30\n')
    expect(filtered(TEXT, ['tail -3'])).toBe('line 28\nline 29\nline 30\n')
    expect(filtered(TEXT, ['tail -n +29'])).toBe('line 29\nline 30\n')
    expect(filtered(TEXT, ['head -n2'])).toBe('line 1\nline 2\n')
    expect(filtered(TEXT, ['head'])?.split('\n')).toHaveLength(11)
    expect(filtered(TEXT, ['head -n -28'])).toBe('line 1\nline 2\n')
  })

  test('gives what grep would print, its context and the -- between groups included', () => {
    expect(filtered(TEXT, ['grep FAIL'])).toBe('line 15 FAIL here\n')
    expect(filtered(TEXT, ['grep -C1 FAIL'])).toBe('line 14\nline 15 FAIL here\nline 16\n')
    expect(filtered(TEXT, ['grep -E "line (1|30)$"'])).toBe('line 1\nline 30\n')
    expect(filtered(TEXT, ['grep "line \\(1\\|30\\)$"'])).toBe('line 1\nline 30\n')
    expect(filtered(TEXT, ['grep -A1 -E "line (1|30)$"'])).toBe('line 1\nline 2\n--\nline 30\n')
    expect(filtered(TEXT, ['grep -vi line'])).toBe('')
    expect(filtered(TEXT, ['grep -F "(x"'])).toBe('')
  })

  test('chains the stages in order, and gives up on one it cannot read', () => {
    expect(filtered(TEXT, ['grep -v FAIL', 'tail -1'])).toBe('line 30\n')
    expect(filtered(TEXT, ['tail -f'])).toBeUndefined()
    expect(filtered(TEXT, ['grep --color=always x'])).toBeUndefined()
    expect(filtered(TEXT, ['sort'])).toBeUndefined()
  })
})

describe('commandKey', () => {
  test('keeps the words naming the command and none of its arguments', () => {
    expect(commandKey(['bun', 'run', 'build', '--minify'])).toBe('bun run build')
    expect(commandKey(['/usr/bin/docker', 'compose', 'exec', 'php'])).toBe('docker compose exec')
    expect(commandKey(['vendor/bin/phpunit', '--filter', 'secret'])).toBe('phpunit')
    expect(commandKey(['curl', 'https://user:pw@host/x'])).toBe('curl')
    expect(commandKey(['sh', '-c', 'cd a && bun test'])).toBe('bun test')
    expect(commandKey(['sh', '-c', 'TOKEN=abc bun test'])).toBe('bun test')
    expect(commandKey(['API_KEY=x9', 'mycli', 'login', 'sk3cRet'])).toBe('mycli login')
  })
})

describe('stats', () => {
  const entry = (command: string, bytes: number, baseline: number, shown: number, at = '2026-11-01T10:00:00.000Z'): Entry => ({ at, dir: '/repo', command, bytes, baseline, shown, folded: shown < bytes })

  test('are appended to a JSONL file and read back since a date, a broken line skipped', async () => {
    const path = join(dir, 'a', 'stats.jsonl')

    record(entry('bun test', 4000, 4000, 400, '2026-10-01T00:00:00.000Z'), path)
    record(entry('bun install', 800, 800, 800), path)
    await Bun.write(path, `${await Bun.file(path).text()}not json\n`)

    expect((await readEntries(path)).map(each => each.command)).toEqual(['bun test', 'bun install'])
    expect((await readEntries(path, Date.parse('2026-10-15'))).map(each => each.command)).toEqual(['bun install'])
    expect(await readEntries(join(dir, 'missing.jsonl'))).toEqual([])
  })

  test('count the tokens saved against the baseline, a tail that printed less than out showed counting against', () => {
    const summary = summarize([entry('bun test', 40_000, 40_000, 4000), entry('bun test', 40_000, 40_000, 4000), entry('bun run lint', 8000, 400, 2000)])

    expect(summary).toMatchObject({ runs: 3, folded: 3, bytes: 88_000, shown: 10_000, tokensSaved: 17_600 })
    expect(summary.commands.map(each => [each.command, each.tokensSaved])).toEqual([['bun test', 18_000], ['bun run lint', -400]])
    expect(renderSummary(summary, 'recorded')).toContain('about 17,600 tokens saved (bytes / 4)')
    expect(renderSummary(summarize([]), 'in the last 7d')).toBe('no run of out recorded in the last 7d')
  })
})
