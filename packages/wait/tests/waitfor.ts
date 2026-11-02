import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { beforeEach } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

// Called at the top of a test file: runs the waitfor CLI as a child in a fresh folder per test. The tests are split by condition across files, so `bun test --parallel` runs their real waits side by side.
export function waitforHarness() {
  const temp = tempDirs()
  let current = ''

  beforeEach(() => {
    current = temp('waitfor-test-')
  })

  return {
    dir: () => current,
    // Writes app.log in the test's folder and answers its path.
    log: (text: string): string => {
      const path = join(current, 'app.log')

      writeFileSync(path, text)

      return path
    },
    waitfor: async (args: string[], meanwhile?: () => Promise<void>, env: Record<string, string | undefined> = process.env) => {
      const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: current, env, stdout: 'pipe', stderr: 'pipe' })

      await meanwhile?.()

      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])

      return { code, out, err }
    },
  }
}
