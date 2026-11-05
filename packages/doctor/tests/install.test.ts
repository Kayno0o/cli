import type { Host } from '../src/checks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { ABOUT, NEEDS } from '../src/catalog'
import { TOOLS } from '../src/checks'
import { main } from '../src/doctor'
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
    which: bin => absent.includes(bin) ? null : `/bin/${bin}`,
    run: async (argv) => {
      const line = argv.join(' ')

      ran.push(line)

      if (line.startsWith('bun install -g')) {
        for (const name of argv.slice(3)) {
          put(name, '0.1.0')
        }
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

describe('doctor --install', () => {
  test('installs the named packages in one call, by package or by bin, then checks them', async () => {
    const { host, ran } = recording(['fish'])
    const { result, out } = await capture(async () => main(['--install', 'forgejo', 'sub'], host))

    expect(ran.filter(line => line.startsWith('bun install'))).toEqual(['bun install -g @kaynooo/cli-forgejo @kaynooo/cli-edit'])
    expect(out).toContain('after the install:')
    expect(out).toContain('cli-forgejo')
    expect(result).toBe(0)
  })

  test('leaves out a package whose tool is missing, unless --force', async () => {
    const blocked = recording(['glab'])
    const refused = await capture(async () => main(['--install', 'gitlab', 'git'], blocked.host))

    expect(refused.result).toBe(1)
    expect(refused.out).toContain('blocked  gitlab needs glab (gl goes through it)')
    expect(blocked.ran.filter(line => line.startsWith('bun install'))).toEqual(['bun install -g @kaynooo/cli-git'])

    const forced = recording(['glab'])

    await capture(async () => main(['--install', 'gitlab', '--force'], forced.host))
    expect(forced.ran.filter(line => line.startsWith('bun install'))).toEqual(['bun install -g @kaynooo/cli-gitlab'])
  })

  test('hooks brings guard along and runs the plugin install', async () => {
    const { host, ran } = recording([])

    await capture(async () => main(['--install', 'hooks'], host))
    expect(ran).toContain('bun install -g @kaynooo/cli-guard')
    expect(ran).toContain('claude plugin install cli-hooks --marketplace https://git.kaynooo.fr/kaynooo/cli.git')
  })

  test('--dry-run runs nothing, all names every package, and an installed one is skipped', async () => {
    put('@kaynooo/cli-edit', '0.1.0')

    const { host, ran } = recording([])
    const { result, out } = await capture(async () => main(['--install', 'all', 'sub', '--dry-run'], host))

    expect(ran).toEqual([])
    expect(result).toBe(0)
    expect(out).toContain('would')
    expect(out).toContain('@kaynooo/cli-forgejo')
    expect(out).not.toContain('@kaynooo/cli-edit')
  })

  test('--list prints the choices, and a name nothing matches is a usage error', async () => {
    put('@kaynooo/cli-edit', '0.1.0')

    const { host } = recording([])
    const listed = await capture(async () => main(['--install', '--list'], host))

    expect(listed.out).toContain('forgejo')
    expect(listed.out).toContain('hooks')
    expect(listed.out).not.toContain('edit ')

    let refusal = ''

    try {
      await capture(async () => main(['--install', 'nope'], host))
    }
    catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }

    expect(refusal).toContain('nope')
  })

  test('names, --list and --force are refused without --install', async () => {
    let refusal = ''

    try {
      await capture(async () => main(['forgejo'], recording([]).host))
    }
    catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }

    expect(refusal).toContain('--install')
  })
})

describe('doctor --install, checking and unchecking', () => {
  test('installs what was checked and removes what was unchecked, hooks keeping guard', async () => {
    put('@kaynooo/cli-edit', '1.0.0')
    put('@kaynooo/cli-guard', '1.0.0')

    const { host, ran } = recording([])
    const { result } = await capture(async () => install(host, { names: [], list: false, dryRun: false, force: false }, async () => 0, async (all) => {
      const named = (id: string) => all.find(each => each.id === id)!

      expect(named('@kaynooo/cli-edit').installed).toBe(true)
      expect(named('@kaynooo/cli-forgejo').installed).toBe(false)

      return { add: [named('@kaynooo/cli-forgejo')], remove: [named('@kaynooo/cli-edit')] }
    }))

    expect(result).toBe(0)
    expect(ran.filter(line => line.startsWith('bun '))).toEqual(['bun install -g @kaynooo/cli-forgejo', 'bun remove -g @kaynooo/cli-edit'])
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
