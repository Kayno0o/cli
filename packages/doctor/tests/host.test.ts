import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { hostHere } from '../src/host'

describe.if(Bun.which('getent') !== null)('hostHere', () => {
  test('takes the login shell from the password database, not $SHELL, which a tool running doctor may set', () => {
    const entry = readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':')).find(fields => fields[2] === String(process.getuid?.()))
    const saved = process.env.SHELL

    process.env.SHELL = '/bin/not-a-shell'

    try {
      expect(hostHere().shell).toBe(basename(entry?.[6] ?? ''))
    }
    finally {
      if (saved === undefined)
        delete process.env.SHELL
      else
        process.env.SHELL = saved
    }
  })
})
