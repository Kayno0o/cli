import type { Description } from '../packages/kit/src/args'
import { describe, expect, test } from 'bun:test'
import { bins, run } from './bins'

// What `agent-tools list` reads off each bin, so a bin that stops describing itself fails here rather than drops off the list.
describe('every bin describes itself', () => {
  for (const { bin, source } of bins) {
    test(bin, () => {
      const described = JSON.parse(run(source, ['--help'], { KIT_HELP: 'json' })) as Description

      expect(described.summary).not.toBe('')
      expect(described.replaces ?? '').not.toBe('')
      expect(described.examples.length).toBeGreaterThanOrEqual(2)
      expect(described.examples.filter(({ line }) => !line.includes(bin))).toEqual([])
    })
  }
})
