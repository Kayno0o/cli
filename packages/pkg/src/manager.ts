import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const MANAGERS = ['bun', 'yarn', 'pnpm', 'npm', 'composer', 'uv'] as const
export const ACTIONS = ['install', 'dev', 'remove', 'update', 'exec'] as const

export type Manager = typeof MANAGERS[number]
export type Action = typeof ACTIONS[number]

// The lockfiles that tell a manager, in the order they are checked in one folder.
const LOCKFILES: [file: string, manager: Manager][] = [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['yarn.lock', 'yarn'], ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['composer.json', 'composer'], ['uv.lock', 'uv']]

// The command each manager runs for an action; a missing manager falls back to npm's spelling.
const COMMANDS: Record<Action, Partial<Record<Manager, string>> & { fallback: (manager: Manager) => string }> = {
  install: { yarn: 'yarn add', uv: 'uv sync', fallback: manager => `${manager} install` },
  dev: { bun: 'bun add -d', yarn: 'yarn add -D', pnpm: 'pnpm add -D', composer: 'composer require --dev', uv: 'uv add --dev', fallback: () => 'npm install -D' },
  remove: { npm: 'npm uninstall', fallback: manager => `${manager} remove` },
  update: { yarn: 'yarn upgrade', uv: 'uv lock --upgrade', fallback: manager => `${manager} update` },
  exec: { bun: 'bunx', pnpm: 'pnpm dlx', yarn: 'yarn dlx', composer: 'composer exec', uv: 'uvx', fallback: () => 'npx' },
}

// The manager of the nearest folder, from `from` up to the root, holding a lockfile or a composer.json; bun when none does.
export function detectManager(from: string): Manager {
  let dir = from

  while (true) {
    const found = LOCKFILES.find(([file]) => existsSync(join(dir, file)))

    if (found !== undefined)
      return found[1]

    const parent = dirname(dir)

    if (parent === dir)
      return 'bun'

    dir = parent
  }
}

export function commandFor(action: Action, manager: Manager): string {
  const { fallback, ...own } = COMMANDS[action]

  return own[manager] ?? fallback(manager)
}
