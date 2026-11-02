import type { Host } from '../src/checks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { checkBun, checkHooks, checkTea, checkTool, runChecks, TOOLS } from '../src/checks'
import { main } from '../src/cli'

const temp = tempDirs()

let home = ''

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function install(name: string, version: string, bun = '>=1.4.3'): void {
  write(join(home, 'modules', name, 'package.json'), { name, version, engines: { bun } })
}

// A host whose commands answer from `answers`, keyed by the argv joined with spaces, and whose PATH holds `onPath`.
function fakeHost(answers: Record<string, { code?: number, stdout?: string, stderr?: string }> = {}, onPath: string[] = ['ft', 'tea']): Host {
  return {
    home,
    globalModules: join(home, 'modules'),
    bunVersion: '1.4.4',
    which: bin => onPath.includes(bin) ? `/bin/${bin}` : null,
    run: async (argv) => {
      const answer = answers[argv.join(' ')] ?? { code: 1, stderr: `no stub for ${argv.join(' ')}` }

      return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    },
  }
}

const LATEST = { 'bun info @kaynooo/cli-forgejo version --no-cache': { stdout: '0.5.1\n' } }

beforeEach(() => {
  home = temp('doctor-')
})

describe('checkTool', () => {
  test('passes an installed package as new as the registry\'s', async () => {
    install('@kaynooo/cli-forgejo', '0.5.1')

    expect(await checkTool(fakeHost(LATEST), '@kaynooo/cli-forgejo', ['ft'])).toEqual({ check: 'cli-forgejo', ok: true, detail: '0.5.1' })
  })

  test('fails one missing, older than released or with a bin off the PATH, naming the fix', async () => {
    expect(await checkTool(fakeHost(LATEST), '@kaynooo/cli-forgejo', ['ft'])).toMatchObject({ ok: false, detail: 'not installed', fix: 'bun install -g @kaynooo/cli-forgejo' })
    install('@kaynooo/cli-forgejo', '0.5.0')
    expect(await checkTool(fakeHost(LATEST), '@kaynooo/cli-forgejo', ['ft'])).toMatchObject({ ok: false, detail: '0.5.0, 0.5.1 released', fix: 'bun install -g @kaynooo/cli-forgejo@0.5.1' })
    expect(await checkTool(fakeHost(LATEST, []), '@kaynooo/cli-forgejo', ['ft'])).toMatchObject({ ok: false, detail: '0.5.0, ft not on the PATH' })
  })

  test('passes with a note when the registry does not answer', async () => {
    install('@kaynooo/cli-forgejo', '0.5.0')

    expect(await checkTool(fakeHost(), '@kaynooo/cli-forgejo', ['ft'])).toMatchObject({ ok: true, detail: '0.5.0, the registry did not answer: no stub for bun info @kaynooo/cli-forgejo version --no-cache' })
  })
})

describe('runChecks', () => {
  test('asks the registry for at most four packages at once, and ignores an answer that is no version', async () => {
    let running = 0
    let peak = 0
    const host: Host = {
      ...fakeHost({}, []),
      run: async () => {
        running++
        peak = Math.max(peak, running)
        await Bun.sleep(10)
        running--

        return { code: 0, stdout: '<html>captive portal</html>', stderr: '' }
      },
    }

    for (const name of Object.keys(TOOLS))
      install(name, '0.1.0')

    expect(await checkTool({ ...host, which: () => '/bin/x' }, '@kaynooo/cli-forgejo', ['ft'])).toMatchObject({ ok: true, detail: expect.stringContaining('the registry did not answer') })
    await runChecks({ ...host, which: () => '/bin/x' })
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe('checkTea', () => {
  const logins = { 'tea login list -o json': { stdout: JSON.stringify([{ name: 'forge', url: 'https://git.kaynooo.fr' }]) } }

  test('passes a login reaching the forge, by its public or its private name', async () => {
    expect(await checkTea(fakeHost({ ...logins, 'tea api --login forge version': { stdout: '{"version":"16.0.6"}' } }))).toEqual({ check: 'tea', ok: true, detail: 'logged in to git.kaynooo.fr as forge, Forgejo 16.0.6' })

    const publicLogin = { 'tea login list -o json': { stdout: JSON.stringify([{ name: 'pub', url: 'https://git.kaynooo.fr' }]) }, 'tea api --login pub version': { stdout: '{"version":"16.0.6"}' } }

    expect(await checkTea(fakeHost(publicLogin))).toMatchObject({ ok: true, detail: 'logged in to git.kaynooo.fr as pub, Forgejo 16.0.6' })
  })

  test('fails without tea, without a login to the forge, or when the forge does not answer', async () => {
    expect(await checkTea(fakeHost({}, []))).toMatchObject({ ok: false, detail: 'not installed, and ft goes through it' })
    expect(await checkTea(fakeHost({ 'tea login list -o json': { stdout: '[{"name":"gh","url":"https://gitea.com"}]' } }))).toMatchObject({ ok: false, fix: 'tea login add --url https://git.kaynooo.fr --oauth' })
    expect(await checkTea(fakeHost({ ...logins, 'tea api --login forge version': { code: 1, stderr: 'dial tcp: timeout\n' } }))).toMatchObject({ ok: false, detail: 'git.kaynooo.fr did not answer: dial tcp: timeout' })
  })
})

describe('checkHooks', () => {
  test('passes the plugin or the mod, one of them only', () => {
    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'cli-hooks@kaynooo-cli': true } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: true, detail: 'the cli-hooks@kaynooo-cli plugin' })

    write(join(home, '.claude', 'mods', 'cli', 'hooks', 'hooks.json'), '{}')
    write(join(home, '.claude', 'settings.json'), { env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/guards:~/.claude/mods/cli' } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: true, detail: `the cli mod in ${home}/.claude/mods/cli` })

    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'cli-hooks@kaynooo-cli': true }, env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/cli' } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: false, fix: 'claude plugin disable cli-hooks@kaynooo-cli' })
  })

  test('fails with neither, settings missing included', () => {
    expect(checkHooks(fakeHost())).toMatchObject({ ok: false, fix: 'claude plugin install cli-hooks --marketplace https://git.kaynooo.fr/kaynooo/agent-tools.git' })
  })
})

describe('checkBun', () => {
  test('fails a Bun older than an installed package asks for', () => {
    install('@kaynooo/cli-forgejo', '0.5.1', '>=1.5.0')
    install('@kaynooo/cli-git', '0.2.0')

    expect(checkBun(fakeHost())).toEqual({ check: 'bun', ok: false, detail: '1.4.4, the tools ask for >=1.5.0', fix: 'bun upgrade' })
  })
})

describe('doctor', () => {
  test('prints one line per check and exits 1 on a failure, or JSON', async () => {
    const { result, out } = await capture(async () => main([], fakeHost()))

    expect(result).toBe(1)
    expect(out.split('\n').filter(line => line.startsWith('FAIL')).length).toBeGreaterThan(Object.keys(TOOLS).length)
    expect(out).toContain(`fix them all: bun install -g ${Object.keys(TOOLS).join(' ')}`)

    const json = JSON.parse((await capture(async () => main(['--json'], fakeHost()))).out) as { check: string }[]

    expect(json.map(each => each.check).slice(-3)).toEqual(['tea', 'hooks', 'bun'])
  })
})
