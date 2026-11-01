import type { Host } from '../src/checks'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture } from '@kaynooo/cli-kit/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { checkBun, checkHooks, checkTea, checkTool, TOOLS } from '../src/checks'
import { main } from '../src/cli'

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

const LATEST = { 'bun info @kaynooo/forgejo-tools version --no-cache': { stdout: '0.5.1\n' } }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'doctor-'))
})

describe('checkTool', () => {
  test('passes an installed package as new as the registry\'s', async () => {
    install('@kaynooo/forgejo-tools', '0.5.1')

    expect(await checkTool(fakeHost(LATEST), '@kaynooo/forgejo-tools', ['ft'])).toEqual({ check: 'forgejo-tools', ok: true, detail: '0.5.1' })
  })

  test('fails one missing, older than released or with a bin off the PATH, naming the fix', async () => {
    expect(await checkTool(fakeHost(LATEST), '@kaynooo/forgejo-tools', ['ft'])).toMatchObject({ ok: false, detail: 'not installed', fix: 'bun install -g @kaynooo/forgejo-tools' })
    install('@kaynooo/forgejo-tools', '0.5.0')
    expect(await checkTool(fakeHost(LATEST), '@kaynooo/forgejo-tools', ['ft'])).toMatchObject({ ok: false, detail: '0.5.0, 0.5.1 released', fix: 'bun install -g @kaynooo/forgejo-tools@0.5.1' })
    expect(await checkTool(fakeHost(LATEST, []), '@kaynooo/forgejo-tools', ['ft'])).toMatchObject({ ok: false, detail: '0.5.0, ft not on the PATH' })
  })

  test('passes with a note when the registry does not answer', async () => {
    install('@kaynooo/forgejo-tools', '0.5.0')

    expect(await checkTool(fakeHost(), '@kaynooo/forgejo-tools', ['ft'])).toMatchObject({ ok: true, detail: '0.5.0, the registry did not answer: no stub for bun info @kaynooo/forgejo-tools version --no-cache' })
  })
})

describe('checkTea', () => {
  const logins = { 'tea login list -o json': { stdout: JSON.stringify([{ name: 'forge', url: 'https://git.kaynooo.fr' }]) } }

  test('passes a login reaching the forge', async () => {
    expect(await checkTea(fakeHost({ ...logins, 'tea api --login forge version': { stdout: '{"version":"16.0.6"}' } }))).toEqual({ check: 'tea', ok: true, detail: 'logged in to git.kaynooo.fr as forge, Forgejo 16.0.6' })
  })

  test('fails without tea, without a login to the forge, or when the forge does not answer', async () => {
    expect(await checkTea(fakeHost({}, []))).toMatchObject({ ok: false, detail: 'not installed, and ft goes through it' })
    expect(await checkTea(fakeHost({ 'tea login list -o json': { stdout: '[{"name":"gh","url":"https://gitea.com"}]' } }))).toMatchObject({ ok: false, fix: 'tea login add --url https://git.kaynooo.fr --oauth' })
    expect(await checkTea(fakeHost({ ...logins, 'tea api --login forge version': { code: 1, stderr: 'dial tcp: timeout\n' } }))).toMatchObject({ ok: false, detail: 'git.kaynooo.fr did not answer: dial tcp: timeout' })
  })
})

describe('checkHooks', () => {
  test('passes the plugin or the mod, one of them only', () => {
    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'agent-tools-hooks@agent-tools': true } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: true, detail: 'the agent-tools-hooks@agent-tools plugin' })

    write(join(home, '.claude', 'mods', 'agent-tools', 'hooks', 'hooks.json'), '{}')
    write(join(home, '.claude', 'settings.json'), { env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/guards:~/.claude/mods/agent-tools' } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: true, detail: `the agent-tools mod in ${home}/.claude/mods/agent-tools` })

    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'agent-tools-hooks@agent-tools': true }, env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/agent-tools' } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: false, fix: 'claude plugin disable agent-tools-hooks@agent-tools' })
  })

  test('fails with neither, settings missing included', () => {
    expect(checkHooks(fakeHost())).toMatchObject({ ok: false, fix: 'claude plugin install agent-tools-hooks --marketplace https://git.kaynooo.fr/kaynooo/agent-tools.git' })
  })
})

describe('checkBun', () => {
  test('fails a Bun older than an installed package asks for', () => {
    install('@kaynooo/forgejo-tools', '0.5.1', '>=1.5.0')
    install('@kaynooo/git-tools', '0.2.0')

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
