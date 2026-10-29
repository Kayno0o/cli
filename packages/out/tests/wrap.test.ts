import { describe, expect, test } from 'bun:test'
import { shouldWrap, wrap } from '../src/wrap'

describe('shouldWrap', () => {
  test.each([
    'bun install',
    'bun add zod',
    'bun test',
    'bun run test',
    'bun run lint:fix',
    'bun run check && bun run lint && bun run test',
    'bunx tsc --noEmit',
    'cd packages/ft && bun test',
    'FORCE_COLOR=0 bun test',
    'just release',
    'docker compose build api',
    'docker build -t app .',
    'cargo build --release',
    'composer install',
    'eslint .',
    'pytest -q',
  ])('wraps %s', (command) => {
    expect(shouldWrap(command)).toBe(true)
  })

  test.each([
    'cat package.json',
    'git diff',
    'sed -n 1,20p src/a.ts',
    'ls -la',
    'bun run dev',
    'bun run test --json',
    'bun install --help',
    'bun test | jq .',
    'bun test > out.txt',
    'bun test &',
    'bun test 2>&1 | tail -5',
    'echo $(bun test)',
    'bun test && git status',
    'cd packages',
    'just --list',
    'docker compose up',
    'docker compose logs api',
    'out -- bun test',
    '',
  ])('leaves %s alone', (command) => {
    expect(shouldWrap(command)).toBe(false)
  })

  test('ignores operators inside quotes', () => {
    expect(shouldWrap('bun test -t "a && b | c"')).toBe(true)
  })
})

describe('wrap', () => {
  test('prefixes a simple command', () => {
    expect(wrap('bun install')).toBe('out -- bun install')
    expect(wrap('  bunx tsc -p "a b"  ')).toBe('out -- bunx tsc -p "a b"')
  })

  test('sends compound commands and assignments through sh -c, quoting single quotes', () => {
    expect(wrap('bun run check && bun run test')).toBe('out -- sh -c \'bun run check && bun run test\'')
    expect(wrap('FORCE_COLOR=0 bun test')).toBe('out -- sh -c \'FORCE_COLOR=0 bun test\'')
    expect(wrap('cd a && bun test -t \'x\'')).toBe('out -- sh -c \'cd a && bun test -t \'\\\'\'x\'\\\'\'\'')
  })
})
