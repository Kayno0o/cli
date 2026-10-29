const ASSIGNMENT = /^\w+=/
const EXCLUDED = /(?:^|\s)(?:--json|--help|--version|-h)(?:\s|$)/
const WORDS = /\s+/
const BUN_SCRIPT = /^(?:build|check|lint|typecheck|types|test|ci|verify|compile)(?::|$)/
const BUN_TOOLS = new Set(['tsc', 'tsgo', 'eslint', 'keslint', 'vitest', 'jest', 'prettier', 'playwright', 'biome'])
const BUN_SUBCOMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'test', 'check', 'lint', 'build'])

type Rule = (args: string[]) => boolean

const always: Rule = () => true

const RULES: Record<string, Rule> = {
  bun: ([sub, script]) => sub !== undefined && (BUN_SUBCOMMANDS.has(sub) || (sub === 'run' && script !== undefined && BUN_SCRIPT.test(script))),
  bunx: ([tool]) => tool !== undefined && BUN_TOOLS.has(tool),
  tsc: always,
  tsgo: always,
  eslint: always,
  keslint: always,
  vitest: always,
  jest: always,
  pytest: always,
  phpunit: always,
  phpstan: always,
  pest: always,
  make: always,
  check: always,
  just: ([first]) => first !== undefined && !first.startsWith('-'),
  composer: ([sub]) => sub === 'install' || sub === 'update' || sub === 'require',
  pip: ([sub]) => sub === 'install',
  cargo: ([sub]) => ['build', 'test', 'check', 'clippy'].includes(sub ?? ''),
  go: ([sub]) => ['build', 'test', 'vet'].includes(sub ?? ''),
  docker: ([sub, second]) => sub === 'build' || (sub === 'compose' && ['build', 'pull'].includes(second ?? '')),
}

interface Scan {
  segments: string[]
  // False when the line pipes, redirects, backgrounds or substitutes, which wrapping would change.
  plain: boolean
}

// Splits on && || ; and newlines outside quotes.
function scan(command: string): Scan {
  const segments: string[] = []
  let current = ''
  let quote: string | undefined
  let plain = true

  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    const next = command[i + 1]

    if (quote !== undefined) {
      if (char === '\\' && quote === '"') {
        current += char + (next ?? '')
        i++

        continue
      }

      if (char === quote)
        quote = undefined
      else if (quote === '"' && (char === '`' || (char === '$' && next === '(')))
        plain = false

      current += char

      continue
    }

    if (char === '\\') {
      current += char + (next ?? '')
      i++

      continue
    }

    if (char === '\'' || char === '"') {
      quote = char
      current += char

      continue
    }

    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      segments.push(current)
      current = ''
      i++

      continue
    }

    if (char === ';' || char === '\n') {
      segments.push(current)
      current = ''

      continue
    }

    if (char === '|' || char === '&' || char === '<' || char === '>' || char === '`' || char === '(' || char === ')' || (char === '$' && next === '('))
      plain = false

    current += char
  }

  segments.push(current)

  return { segments: segments.map(segment => segment.trim()).filter(segment => segment !== ''), plain: plain && quote === undefined }
}

function listed(segment: string): boolean {
  if (EXCLUDED.test(segment))
    return false

  const words = segment.split(WORDS)

  while (words[0] !== undefined && ASSIGNMENT.test(words[0]))
    words.shift()

  const [bin, ...args] = words

  if (bin === undefined)
    return false

  return RULES[bin]?.(args) ?? false
}

// A `cd` ahead of the real command is harmless to wrap.
function isCd(segment: string): boolean {
  return segment === 'cd' || segment.startsWith('cd ')
}

// True when the line is made only of listed noisy commands (and cd), with no pipe, redirect, background or substitution, and at least one command is listed.
export function shouldWrap(command: string): boolean {
  const { segments, plain } = scan(command.trim())

  if (!plain || !segments.some(segment => listed(segment)))
    return false

  return segments.every(segment => isCd(segment) || listed(segment))
}

function quoted(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

// The command line to run instead: `out -- <cmd>`, through `sh -c` when it chains commands or starts with an assignment.
export function wrap(command: string): string {
  const trimmed = command.trim()

  if (scan(trimmed).segments.length <= 1 && !ASSIGNMENT.test(trimmed))
    return `out -- ${trimmed}`

  return `out -- sh -c ${quoted(trimmed)}`
}
