import process from 'node:process'
import { describe, expect, test } from 'bun:test'

describe('the Bun bug sessionDirs works around', () => {
  // Once this fails, sessionDirs can go back to homedir() alone.
  test('Bun\'s os.homedir() still keeps the HOME the process began with, oven-sh/bun#29244', () => {
    const child = Bun.spawnSync([process.execPath, '-e', 'process.env.HOME = "/not-home"; console.log(require("node:os").homedir())'], { env: { ...process.env, HOME: '/began-home' } })

    expect(child.stdout.toString().trim()).toBe('/began-home')
  })
})
