import { describe, expect, test } from 'bun:test'
import { addedPackages } from '../src/added'

describe('addedPackages', () => {
  const checked: [string, string[]][] = [
    ['bun add -d zod', ['zod']],
    ['bun add zod@4.1.0', ['zod@4.1.0']],
    ['bun add @scope/name', ['@scope/name']],
    ['npm install --save-dev zod left-pad', ['zod', 'left-pad']],
    ['cd app && pnpm add --filter web zod', ['zod']],
    ['yarn add "zod@^4"', ['zod@^4']],
    ['bun add alias@npm:zod@4.1.0', ['zod@4.1.0']],
    ['bun add -g zod@4.1.0 2>&1 | tail -3', ['zod@4.1.0']],
    ['bun add zod > log', ['zod']],
    ['bun add zod 2>/dev/null', ['zod']],
    ['bun add -g zod && ft release patch', ['zod']],
    ['sudo FOO=1 bun add zod', ['zod']],
    ['bunx zod-cli --help', ['zod-cli']],
    ['npx -y create-thing@1.0.0 my-app', ['create-thing@1.0.0']],
    ['npx --yes --registry https://r.test cowsay hi', ['cowsay']],
    ['npx -p typescript -p ts-node ts-node x.ts', ['typescript', 'ts-node']],
    ['bun x prettier --write .', ['prettier']],
    ['pnpm dlx create-vite my-app', ['create-vite']],
    ['pnpm i zod', ['zod']],
    ['pnpm install -D zod left-pad', ['zod', 'left-pad']],
    ['npm i --loglevel silent foo', ['foo']],
    ['npm exec cowsay', ['cowsay']],
  ]

  for (const [command, names] of checked) {
    test(`finds ${names.join(', ')} in ${command}`, () => {
      expect(addedPackages(command)).toEqual(names)
    })
  }

  for (const command of ['bunx ./script.ts', 'npx github:owner/repo', 'pnpm install', 'bun x', 'bun install', 'bun install --frozen-lockfile', 'bun add ./local', 'bun add github:owner/repo', 'bun add owner/repo', 'pnpm add workspace:*', 'npm i file:../lib', 'bun run add', 'ft release patch -p env && bun install -g @kaynooo/cli-env@0.3.3', 'bun packages/ft/src/cli.ts release patch; bun add -g @kaynooo/cli-forgejo@9.9.9', 'just minor && bun update @kaynooo/utils && bun add @kaynooo/utils@9.9.9', 'cat > a.md <<\'EOF\'\nbun add zod\nEOF']) {
    test(`finds none in ${command}`, () => {
      expect(addedPackages(command)).toEqual([])
    })
  }
})
