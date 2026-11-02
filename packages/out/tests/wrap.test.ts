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
    'docker compose exec -T php vendor/bin/phpunit --filter Foo',
    'docker compose exec php php bin/phpunit',
    'docker compose -f compose.test.yaml run --rm -e APP_ENV=test php bin/phpunit',
    'docker exec -it -u www-data app vendor/bin/pest',
    'docker compose exec php composer install',
    'php -d memory_limit=-1 vendor/bin/phpstan analyse',
    'XDEBUG_MODE=off vendor/bin/paratest -p8',
    'bunx vue-tsc --noEmit',
    'bunx --bun nuxi typecheck',
    'vendor/bin/php-cs-fixer fix --dry-run',
    'vendor/bin/rector process --dry-run',
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
    'bun test | tail -5 > log.txt',
    'bun test | grep -c pass',
    'bun test | grep -vq pass',
    'bun test | tail -5 && git status',
    'bun test 2>&1 | tail -40',
    'bun test | head -n 149',
    'bun test | tail -n +5',
    'docker compose exec -T php vendor/bin/phpunit | grep -E "FAIL|Tests:"',
    'bun test | grep -C3 FAIL',
    'bun run test 2>&1 | grep -v skip | head -200',
    'docker compose exec php bin/console cache:clear',
    'docker compose exec php sh -c "vendor/bin/phpunit"',
    'docker compose up -d',
    'php bin/console about',
    'bunx nuxi dev',
    'echo $(bun test)',
    'bun test && git status',
    'cd packages',
    'just --list',
    'vitest --watch',
    'tsc --watch',
    'bunx tsc -w',
    'bun test --watch',
    'just dev',
    'make watch',
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

  test.each([
    'bun test 2>&1 | tail -150',
    'bun test | head -n 200',
    'bun test | tail -n300 | head --lines=200',
  ])('wraps %s, its final long tail or head dropped', (command) => {
    expect(shouldWrap(command)).toBe(true)
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

  test('drops a final long tail or head and the 2>&1 feeding it, passing each stage as --was', () => {
    expect(wrap('bun test 2>&1 | tail -150')).toBe('out --was \'tail -150\' -- bun test')
    expect(wrap('cd a && bun run test 2>&1 | tail -n 300 | head -200')).toBe('out --was \'tail -n 300\' --was \'head -200\' -- sh -c \'cd a && bun run test\'')
  })
})
