import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { commandFor, detectManager } from '../src/manager'

const temp = tempDirs()
const CLI = new URL('../src/cli.ts', import.meta.url).pathname

describe('detectManager', () => {
  test('reads the lockfile of the folder or of a parent', () => {
    const root = temp()

    mkdirSync(join(root, 'app/src'), { recursive: true })
    writeFileSync(join(root, 'app/pnpm-lock.yaml'), '')
    writeFileSync(join(root, 'uv.lock'), '')

    expect(detectManager(join(root, 'app/src'))).toBe('pnpm')
    expect(detectManager(root)).toBe('uv')
  })

  test('is bun when nothing tells', () => {
    expect(detectManager(temp())).toBe('bun')
  })
})

describe('commandFor', () => {
  test('spells each action per manager', () => {
    expect(commandFor('install', 'yarn')).toBe('yarn add')
    expect(commandFor('install', 'uv')).toBe('uv sync')
    expect(commandFor('install', 'bun')).toBe('bun install')
    expect(commandFor('dev', 'npm')).toBe('npm install -D')
    expect(commandFor('dev', 'composer')).toBe('composer require --dev')
    expect(commandFor('remove', 'npm')).toBe('npm uninstall')
    expect(commandFor('remove', 'pnpm')).toBe('pnpm remove')
    expect(commandFor('update', 'yarn')).toBe('yarn upgrade')
    expect(commandFor('exec', 'bun')).toBe('bunx')
    expect(commandFor('exec', 'npm')).toBe('npx')
  })
})

describe('pkg manager', () => {
  test('prints the command for the folder it runs in', () => {
    const cwd = temp()

    writeFileSync(join(cwd, 'yarn.lock'), '')

    const result = Bun.spawnSync([process.execPath, CLI, 'manager', 'exec'], { cwd, stdout: 'pipe', stderr: 'pipe' })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('yarn dlx\n')
  })

  test('refuses an unknown action', () => {
    expect(Bun.spawnSync([process.execPath, CLI, 'manager', 'nope'], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(2)
  })
})
