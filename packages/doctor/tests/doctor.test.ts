import type { Host } from '../src/checks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { checkBun, checkHooks, checkNeeds, checkTea, checkTool, runChecks, TOOLS } from '../src/checks'
import { main } from '../src/doctor'

const GUARD = '@kaynooo/cli-guard'

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
    expect(await checkTool(fakeHost(LATEST, []), '@kaynooo/cli-forgejo', ['ft'])).toMatchObject({ ok: false, detail: '0.5.0, 0.5.1 released, ft not on the PATH', fix: 'bun install -g @kaynooo/cli-forgejo@0.5.1' })
    install('@kaynooo/cli-forgejo', '0.5.1')
    expect(await checkTool(fakeHost(LATEST, []), '@kaynooo/cli-forgejo', ['ft'])).toMatchObject({ ok: false, detail: '0.5.1, ft not on the PATH' })
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
    install(GUARD, '0.1.0')
    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'cli-hooks@kaynooo-cli': true } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: true, detail: 'the cli-hooks@kaynooo-cli plugin' })

    write(join(home, '.claude', 'mods', 'cli', 'hooks', 'hooks.json'), '{}')
    write(join(home, '.claude', 'settings.json'), { env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/guards:~/.claude/mods/cli' } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: true, detail: `the cli mod in ${home}/.claude/mods/cli` })

    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'cli-hooks@kaynooo-cli': true }, env: { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/cli' } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: false, fix: 'claude plugin disable cli-hooks@kaynooo-cli' })
  })

  test('fails with neither, settings missing included', () => {
    expect(checkHooks(fakeHost())).toMatchObject({ ok: false, fix: 'claude plugin install cli-hooks --marketplace https://git.kaynooo.fr/kaynooo/cli.git' })
  })

  test('fails when wired without the guard they call', () => {
    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'cli-hooks@kaynooo-cli': true } })
    expect(checkHooks(fakeHost())).toMatchObject({ ok: false, fix: `bun install -g ${GUARD}` })
  })
})

describe('checkNeeds', () => {
  test('fails a required tool of an installed package, only notes an optional one', () => {
    expect(checkNeeds(fakeHost())).toMatchObject({ ok: true, detail: expect.stringContaining('every tool') })

    install('@kaynooo/cli-gitlab', '0.1.0')
    install('@kaynooo/cli-git', '0.1.0')
    expect(checkNeeds(fakeHost())).toMatchObject({ ok: false, detail: 'missing glab (gl goes through it)', fix: expect.stringContaining('glab: https://gitlab.com') })
    expect(checkNeeds(fakeHost({}, ['glab']))).toMatchObject({ ok: true, detail: 'optional, missing fzf (gb picks a branch with it)' })
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
  test('checks only what is installed, exits 1 on a failure, and counts the rest', async () => {
    install('@kaynooo/cli-forgejo', '0.1.0')
    install('@kaynooo/cli-git', '0.1.0')

    const host = fakeHost({ ...LATEST, 'bun info @kaynooo/cli-git version --no-cache': { stdout: '0.2.0\n' } })
    const { result, out } = await capture(async () => main([], host))

    expect(result).toBe(1)
    expect(out.split('\n').filter(line => line.startsWith('FAIL')).map(line => line.split(/\s+/)[1])).toEqual(['cli-forgejo', 'cli-git', 'tea'])
    expect(out).toContain('fix them all: bun install -g @kaynooo/cli-forgejo@0.5.1 @kaynooo/cli-git@0.2.0')
    expect(out).toContain(`${Object.keys(TOOLS).length - 2} packages not installed: doctor --install`)

    const json = JSON.parse((await capture(async () => main(['--json'], host))).out) as { check: string }[]

    expect(json.map(each => each.check)).toEqual(['cli-forgejo', 'cli-git', 'tea', 'needs', 'bun', 'completions'])
  })

  test('has nothing to fail on a host with no package installed', async () => {
    const { result, out } = await capture(async () => main([], fakeHost()))

    expect(result).toBe(0)
    expect(out).not.toContain('FAIL')
  })
})

describe('doctor --only and --quiet', () => {
  test('--only runs just the checks named, and refuses an unknown one', async () => {
    const asked: string[] = []
    const host: Host = { ...fakeHost(), run: async (argv) => {
      asked.push(argv.join(' '))

      return { code: 1, stdout: '', stderr: '' }
    } }
    const { result, out } = await capture(async () => main(['--only', 'hooks', '--only', 'bun'], host))

    expect(out.split('\n').filter(Boolean).map(line => line.split(/\s+/)[1])).toEqual(['hooks', 'bun'])
    expect(result).toBe(1)
    expect(asked).toEqual([])
    let refusal = ''

    try {
      await capture(async () => main(['--only', 'nope'], host))
    }
    catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }

    expect(refusal).toContain('nope')
  })

  test('--quiet prints only the failing checks, nothing when all pass', async () => {
    write(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'cli-hooks@kaynooo-cli': true } })
    install('@kaynooo/cli-doctor', '0.1.0')
    install(GUARD, '0.1.0')

    const passing = await capture(async () => main(['-q', '--only', 'hooks', '--only', 'bun'], fakeHost()))
    const failing = await capture(async () => main(['-q', '--only', 'hooks', '--only', 'cli-forgejo'], fakeHost()))

    expect(passing).toMatchObject({ result: 0, out: '' })
    expect(failing.out).toMatch(/^FAIL {2}cli-forgejo {2}not installed/)
    expect(failing.out.split('\n').filter(Boolean)).toHaveLength(1)
  })
})

describe('doctor --fix', () => {
  // A host recording what it ran, whose bun install fixes the package for the next check.
  function fixingHost(): { host: Host, ran: string[] } {
    const ran: string[] = []
    const host: Host = {
      ...fakeHost({ 'bun info @kaynooo/cli-forgejo version --no-cache': { stdout: '0.5.1\n' }, 'bun info @kaynooo/cli-git version --no-cache': { stdout: '0.2.0\n' } }),
      run: async (argv) => {
        const line = argv.join(' ')

        ran.push(line)

        if (line.startsWith('bun install -g')) {
          install('@kaynooo/cli-forgejo', '0.5.1')
          install('@kaynooo/cli-git', '0.2.0')

          return { code: 0, stdout: '', stderr: '' }
        }

        if (line.startsWith('bun info'))
          return { code: 0, stdout: line.includes('forgejo') ? '0.5.1\n' : '0.2.0\n', stderr: '' }

        return { code: 1, stdout: '', stderr: `no stub for ${line}` }
      },
      which: () => '/bin/x',
    }

    return { host, ran }
  }

  test('runs the installs in one call, then checks again', async () => {
    const { host, ran } = fixingHost()
    const { result, out } = await capture(async () => main(['--fix', '--only', 'cli-forgejo', '--only', 'cli-git'], host))

    expect(ran.filter(line => line.startsWith('bun install'))).toEqual(['bun install -g @kaynooo/cli-forgejo @kaynooo/cli-git'])
    expect(result).toBe(0)
    expect(out).toContain('ran      bun install -g @kaynooo/cli-forgejo @kaynooo/cli-git')
    expect(out).toContain('after the fixes:')
    expect(out.slice(out.indexOf('after the fixes:'))).toContain('ok    cli-forgejo')
  })

  test('--dry-run runs nothing, and a line that is no command is printed as not run', async () => {
    const { host, ran } = fixingHost()

    const dry = await capture(async () => main(['--fix', '--dry-run', '--only', 'cli-forgejo'], host))

    expect(ran.filter(line => line.startsWith('bun install'))).toEqual([])
    expect(dry.result).toBe(1)
    expect(dry.out).toContain('would    bun install -g @kaynooo/cli-forgejo')

    const prose = await capture(async () => main(['--fix', '--only', 'tea'], { ...host, which: () => null }))

    expect(prose.out).toContain('not run  install tea from https://gitea.com/gitea/tea/releases')
    expect(prose.result).toBe(1)
  })

  test('never runs bun upgrade, which replaces Bun itself', async () => {
    install('@kaynooo/cli-forgejo', '0.5.1', '>=9.0.0')

    const { host, ran } = fixingHost()
    const { out } = await capture(async () => main(['--fix', '--only', 'bun'], host))

    expect(ran).not.toContain('bun upgrade')
    expect(out).toContain('not run  bun upgrade')
  })

  test('with --json prints the checks as they stand after the fixes, the fixes going to stderr', async () => {
    const { host } = fixingHost()
    const { out, err } = await capture(async () => main(['--fix', '--json', '--only', 'cli-forgejo'], host))

    expect(JSON.parse(out)).toEqual([{ check: 'cli-forgejo', ok: true, detail: '0.5.1' }])
    expect(err).toContain('bun install -g @kaynooo/cli-forgejo')
  })
})
