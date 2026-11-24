import type { Host } from '../src/checks'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { ABOUT, NEEDS } from '../src/catalog'
import { TOOLS } from '../src/checks'
import { add, remove, update } from '../src/cli-bin'
import { completionDir, installCompletions } from '../src/completions'
import { install, removal } from '../src/install'

const temp = tempDirs()

let home = ''

function put(name: string, version: string): void {
  const path = join(home, 'modules', name, 'package.json')

  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ name, version }))
}

// A host recording what it ran; a bun install -g puts each package it names on disk.
function recording(absent: string[]): { host: Host, ran: string[] } {
  const ran: string[] = []
  const host: Host = {
    home,
    globalModules: join(home, 'modules'),
    bunVersion: '1.4.4',
    shell: '',
    which: bin => absent.includes(bin) ? null : `/bin/${bin}`,
    run: async (argv) => {
      const line = argv.join(' ')

      ran.push(line)

      if (line.startsWith('bun install -g')) {
        for (const name of argv.slice(3))
          put(name.replace(/@[\d.]+$/, ''), '0.1.0')
      }

      if (line === 'tea login list -o json')
        return { code: 0, stdout: JSON.stringify([{ name: 'forge', url: 'https://git.kaynooo.fr' }]), stderr: '' }

      if (line === 'tea api --login forge version')
        return { code: 0, stdout: '{"version":"16.0.6"}', stderr: '' }

      return { code: line.startsWith('bun info') ? 1 : 0, stdout: '', stderr: '' }
    },
  }

  return { host, ran }
}

beforeEach(() => {
  home = temp('doctor-install-')
})

describe('the catalog', () => {
  test('describes every package and needs only packages that exist', () => {
    expect(Object.keys(ABOUT).toSorted()).toEqual(Object.keys(TOOLS).toSorted())
    expect(Object.keys(NEEDS).filter(name => !(name in TOOLS))).toEqual([])
  })
})

describe('cli add, remove and update', () => {
  test('installs the named packages in one call, by package or by bin, then checks them', async () => {
    const { host, ran } = recording(['fish'])
    const { result, out } = await capture(async () => add(['forge', 'sub'], host))

    expect(ran.filter(line => line.startsWith('bun install'))).toEqual(['bun install -g @kaynooo/cli-forge @kaynooo/cli-edit'])
    expect(out).toContain('after the install:')
    expect(out).toContain('cli-forge')
    expect(result).toBe(0)
  })

  test('leaves out a package whose tool is missing, unless --force', async () => {
    const blocked = recording(['docker'])
    const refused = await capture(async () => add(['docker', 'git'], blocked.host))

    expect(refused.result).toBe(1)
    expect(refused.out).toContain('blocked  docker needs docker (dc runs docker compose)')
    expect(blocked.ran.filter(line => line.startsWith('bun install'))).toEqual(['bun install -g @kaynooo/cli-git'])

    const forced = recording(['docker'])

    await capture(async () => add(['docker', '--force'], forced.host))
    expect(forced.ran.filter(line => line.startsWith('bun install'))).toEqual(['bun install -g @kaynooo/cli-docker'])
  })

  test('hooks brings guard along and runs the plugin install', async () => {
    const { host, ran } = recording([])

    await capture(async () => add(['hooks'], host))
    expect(ran).toContain('bun install -g @kaynooo/cli-guard')
    expect(ran).toContain('claude plugin install cli-hooks --marketplace https://github.com/Kayno0o/cli.git')
  })

  test('--dry-run runs nothing, all names every package, and an installed one is skipped', async () => {
    put('@kaynooo/cli-edit', '0.1.0')

    const { host, ran } = recording([])
    const { result, out } = await capture(async () => add(['all', 'sub', '--dry-run'], host))

    expect(ran).toEqual([])
    expect(result).toBe(0)
    expect(out).toContain('would')
    expect(out).toContain('@kaynooo/cli-forge')
    expect(out).not.toContain('@kaynooo/cli-edit')
  })

  test('--list prints every package with its installed status, and a name nothing matches is a usage error', async () => {
    put('@kaynooo/cli-edit', '0.1.0')

    const { host } = recording([])
    const listed = await capture(async () => add(['--list'], host))

    expect(listed.out).toContain('forge')
    expect(listed.out).toContain('not installed')
    expect(listed.out).toContain('hooks')
    expect(listed.out).toMatch(/edit\s+installed/)

    let refusal = ''

    try {
      await capture(async () => add(['nope'], host))
    }
    catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }

    expect(refusal).toContain('nope')
  })

  test('cli remove works non-interactively and supports --dry-run', async () => {
    put('@kaynooo/cli-edit', '0.1.0')

    const { host, ran } = recording([])
    const removed = await capture(async () => remove(['edit', '--dry-run'], host))

    expect(removed.result).toBe(0)
    expect(removed.out).toContain('bun remove -g @kaynooo/cli-edit')
    expect(ran).toEqual([])

    const actual = await capture(async () => remove(['edit'], host))

    expect(actual.result).toBe(0)
    expect(ran).toEqual(['bun remove -g @kaynooo/cli-edit'])
  })

  test('cli update updates installed packages and completions without running unrelated tea/hooks checks', async () => {
    put('@kaynooo/cli-forge', '0.1.0')
    put('@kaynooo/cli-git', '0.2.0')

    const ran: string[] = []
    const host: Host = {
      ...recording(['fish']).host,
      run: async (argv) => {
        const line = argv.join(' ')

        ran.push(line)

        if (line === 'bun info @kaynooo/cli-forge version --no-cache')
          return { code: 0, stdout: '0.2.0\n', stderr: '' }

        if (line === 'bun info @kaynooo/cli-git version --no-cache')
          return { code: 0, stdout: '0.2.0\n', stderr: '' }

        if (line.startsWith('bun install -g')) {
          put('@kaynooo/cli-forge', '0.2.0')

          return { code: 0, stdout: '', stderr: '' }
        }

        return { code: 1, stdout: '', stderr: '' }
      },
    }

    const res = await capture(async () => update([], host))

    expect(res.result).toBe(0)
    expect(ran).toContain('bun install -g @kaynooo/cli-forge@0.2.0')
    expect(ran.filter(line => line.startsWith('bun info'))).toHaveLength(2)
    expect(ran.some(line => line.startsWith('tea '))).toBe(false)
    expect(res.out).not.toContain('hooks')
    // Concise output skips already up-to-date packages.
    expect(res.out).not.toContain('cli-git')
    expect(res.out).toContain('2 packages up to date')

    const alreadyCurrent = await capture(async () => update([], host))

    expect(alreadyCurrent.result).toBe(0)
    expect(alreadyCurrent.out.trim()).toBe('ok: 2 packages up to date')
  })

  test('cli update converges in one run when an upgrade drops a bin, cleaning dead links and stale completions', async () => {
    const modules = join(home, '.bun', 'install', 'global', 'node_modules')
    const binDir = join(home, '.bun', 'bin')
    const writePkg = (name: string, manifest: Record<string, unknown>) => {
      const path = join(modules, name, 'package.json')

      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, JSON.stringify(manifest))
    }

    // Before update: cli-doctor@0.22.0 ships both `doctor` and `cli`; cli-git@0.20.0 is current.
    writePkg('@kaynooo/cli-doctor', { name: '@kaynooo/cli-doctor', version: '0.22.0', bin: { doctor: './dist/cli.js', cli: './dist/cli-bin.js' } })
    mkdirSync(join(modules, '@kaynooo/cli-doctor/dist'), { recursive: true })
    writeFileSync(join(modules, '@kaynooo/cli-doctor/dist/cli.js'), '')
    writeFileSync(join(modules, '@kaynooo/cli-doctor/dist/cli-bin.js'), '')
    writePkg('@kaynooo/cli-git', { name: '@kaynooo/cli-git', version: '0.20.0', bin: { gst: './dist/gst.js' } })
    mkdirSync(join(modules, '@kaynooo/cli-git/dist'), { recursive: true })
    writeFileSync(join(modules, '@kaynooo/cli-git/dist/gst.js'), '')

    mkdirSync(binDir, { recursive: true })
    symlinkSync('../install/global/node_modules/@kaynooo/cli-doctor/dist/cli.js', join(binDir, 'doctor'))
    symlinkSync('../install/global/node_modules/@kaynooo/cli-doctor/dist/cli-bin.js', join(binDir, 'cli'))
    symlinkSync('../install/global/node_modules/@kaynooo/cli-git/dist/gst.js', join(binDir, 'gst'))

    const ran: string[] = []
    const host: Host = {
      home,
      globalModules: modules,
      bunVersion: '1.4.4',
      shell: '',
      which: (bin) => {
        if (bin === 'fish')
          return '/usr/bin/fish'

        return existsSync(join(binDir, bin)) ? join(binDir, bin) : null
      },
      run: async (argv) => {
        const line = argv.join(' ')

        ran.push(line)

        if (line === 'bun info @kaynooo/cli-doctor version --no-cache')
          return { code: 0, stdout: '0.23.0\n', stderr: '' }

        if (line === 'bun info @kaynooo/cli-git version --no-cache')
          return { code: 0, stdout: '0.20.0\n', stderr: '' }

        if (line === 'bun install -g @kaynooo/cli-doctor@0.23.0') {
          // 0.23.0 drops dist/cli.js, leaving the `doctor` symlink broken.
          writePkg('@kaynooo/cli-doctor', { name: '@kaynooo/cli-doctor', version: '0.23.0', bin: { cli: './dist/cli-bin.js' } })
          rmSync(join(modules, '@kaynooo/cli-doctor/dist/cli.js'))

          return { code: 0, stdout: '', stderr: '' }
        }

        if (line === 'cli completions fish --install') {
          await installCompletions(host, completionDir(home))

          return { code: 0, stdout: '', stderr: '' }
        }

        return { code: 1, stdout: '', stderr: `no stub for ${line}` }
      },
    }

    // Seed completions before the update (including doctor.fish).
    await installCompletions(host, completionDir(home))
    expect(existsSync(join(completionDir(home), 'doctor.fish'))).toBe(true)

    const res = await capture(async () => update([], host))

    expect(res.result).toBe(0)
    expect(existsSync(join(binDir, 'doctor'))).toBe(false)
    expect(existsSync(join(completionDir(home), 'doctor.fish'))).toBe(false)
    expect(ran).toContain('bun install -g @kaynooo/cli-doctor@0.23.0')
    expect(ran).toContain('cli completions fish --install')
    expect(res.out).toContain(`ran      rm ${join(binDir, 'doctor')}`)
    expect(res.out).toContain('ran      cli completions fish --install')
    expect(res.out).toContain('2 packages up to date')
    expect(res.out).not.toContain('cli-git')
  })
})

describe('cli manage, checking and unchecking', () => {
  test('installs what was checked and removes what was unchecked, hooks keeping guard', async () => {
    put('@kaynooo/cli-edit', '1.0.0')
    put('@kaynooo/cli-guard', '1.0.0')

    const { host, ran } = recording([])
    const { result } = await capture(async () => install(host, { names: [], list: false, dryRun: false, force: false }, async () => 0, async (all) => {
      const named = (id: string) => all.find(each => each.id === id)!

      expect(named('@kaynooo/cli-edit').installed).toBe(true)
      expect(named('@kaynooo/cli-forge').installed).toBe(false)

      return { add: [named('@kaynooo/cli-forge')], remove: [named('@kaynooo/cli-edit')] }
    }))

    expect(result).toBe(0)
    expect(ran.filter(line => line.startsWith('bun '))).toEqual(['bun install -g @kaynooo/cli-forge', 'bun remove -g @kaynooo/cli-edit'])
  })

  test('--dry-run says what it would remove and runs nothing', async () => {
    put('@kaynooo/cli-edit', '1.0.0')

    const { host, ran } = recording([])
    const { out } = await capture(async () => install(host, { names: [], list: false, dryRun: true, force: false }, async () => 0, async all => ({ add: [], remove: [all.find(each => each.id === '@kaynooo/cli-edit')!] })))

    expect(out).toContain('bun remove -g @kaynooo/cli-edit')
    expect(ran.filter(line => line.startsWith('bun '))).toEqual([])
  })

  test('removal keeps guard while the hooks plugin stays', () => {
    const guard = { id: '@kaynooo/cli-guard', names: [], label: 'guard', hint: '', packages: ['@kaynooo/cli-guard'], installed: true }
    const hooks = { id: 'hooks', names: [], label: 'hooks', hint: '', packages: ['@kaynooo/cli-guard'], installed: true }

    expect(removal([guard, hooks], [guard])).toEqual({ packages: [], plugin: false })
    expect(removal([guard, hooks], [guard, hooks])).toEqual({ packages: ['@kaynooo/cli-guard'], plugin: true })
  })
})
