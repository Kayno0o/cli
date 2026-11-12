import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { devproxyArgv } from '../src/proxy'

test('the installed devproxy runs without loading the .env of the folder wt is called from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-proxy-'))

  try {
    writeFileSync(join(dir, '.env'), 'COMPOSE_PROJECT_NAME=repo--task\n')
    const argv = devproxyArgv('')
    const run = Bun.spawnSync([...argv.slice(0, -1), '-e', 'console.log(process.env.COMPOSE_PROJECT_NAME ?? "unset")'], { cwd: dir, env: { PATH: process.env.PATH ?? '' } })

    expect(argv.at(-1)).toEndWith(join('dist', 'cli.js'))
    expect(run.stdout.toString().trim()).toBe('unset')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
