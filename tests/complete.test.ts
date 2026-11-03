import { describe, expect, test } from 'bun:test'
import { bins } from './bins'

// What the fish completions call, so a bin that stops answering fails here rather than completes nothing.
describe('every bin answers __complete', () => {
  for (const { bin, source } of bins) {
    test(bin, () => {
      const result = Bun.spawnSync([process.execPath, source, '__complete', ''], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

      expect({ code: result.exitCode, err: result.stderr.toString() }).toEqual({ code: 0, err: '' })
    })
  }
})
