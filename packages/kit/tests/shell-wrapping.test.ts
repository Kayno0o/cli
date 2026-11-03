import { describe, expect, test } from 'bun:test'
import { commandsRun, parseCommand, shellQuote, splitCommand } from '../src/shell'

const PAYLOAD = 'git stash'

// Each way a shell can be made to run a command string, so the payload must show up in `commandsRun` under any of them and under two stacked.
const wrappers: Record<string, (inner: string) => string> = {
  'sh -c': inner => `sh -c ${shellQuote(inner)}`,
  'bash -lc': inner => `bash -lc ${shellQuote(inner)}`,
  'docker exec sh -c': inner => `docker exec box sh -c ${shellQuote(inner)}`,
  'eval': inner => `eval ${shellQuote(inner)}`,
  'substitution': inner => `echo $(${inner})`,
  'quoted substitution': inner => `echo "$(${inner})"`,
  'backticks': inner => `echo \`${inner}\``,
  'subshell': inner => `(${inner})`,
  'group': inner => `{ ${inner}; }`,
  'and': inner => `true && ${inner}`,
  'or': inner => `false || ${inner}`,
  'pipe': inner => `echo x | ${inner}`,
  'semicolon': inner => `true; ${inner}`,
  'newline': inner => `true\n${inner}`,
  'assignment': inner => `FOO=1 ${inner}`,
  'env': inner => `env FOO=1 ${inner}`,
  'sudo': inner => `sudo -E ${inner}`,
  'nohup': inner => `nohup ${inner}`,
  'time': inner => `time ${inner}`,
  'timeout': inner => `timeout 5 ${inner}`,
  'nice': inner => `nice -n 5 ${inner}`,
  'find -exec': inner => `find . -exec ${inner} \\;`,
  'heredoc': inner => `sh <<EOF\n${inner}\nEOF`,
  'here-string': inner => `bash <<< ${shellQuote(inner)}`,
  'piped to a shell': inner => `echo ${shellQuote(inner)} | sh`,
}

// The payload counts as run when a piece of some command listed parses to it, whatever surrounds it.
function runs(command: string): boolean {
  return commandsRun(command).some(each => splitCommand(each).some((piece) => {
    const { program, args } = parseCommand(piece.command)

    return program === 'git' && args[0] === 'stash'
  }))
}

describe('commandsRun finds the payload', () => {
  test.each(Object.entries(wrappers))('under %s', (_, wrap) => {
    expect(runs(wrap(PAYLOAD))).toBe(true)
  })

  // Wrappers closing after their body cannot hold a heredoc, whose terminator ends its own line, backquotes cannot nest unescaped, and a `find -exec` takes a simple command.
  const closing = new Set(['substitution', 'quoted substitution', 'backticks', 'subshell', 'group', 'find -exec'])
  const pairs = Object.entries(wrappers).flatMap(([outer, wrapOuter]) => Object.entries(wrappers)
    .filter(([inner]) => !(closing.has(outer) && inner === 'heredoc') && !(outer === 'find -exec' && ['piped to a shell', 'subshell', 'group'].includes(inner)) && !(outer === 'backticks' && inner === 'backticks'))
    .map(([inner, wrapInner]) => [`${outer} over ${inner}`, wrapOuter(wrapInner(PAYLOAD))] as const))

  test.each(pairs)('under %s', (_, command) => {
    expect(runs(command)).toBe(true)
  })
})

describe('commandsRun leaves data alone', () => {
  test.each([
    `echo '$(${PAYLOAD})'`,
    `echo ${shellQuote(PAYLOAD)}`,
    `# ${PAYLOAD}`,
    `grep ${shellQuote(PAYLOAD)} notes.txt`,
    `cat <<'EOF'\n$(${PAYLOAD})\nEOF`,
    `printf %s ${shellQuote(PAYLOAD)} > out.txt`,
  ])('%p', (command) => {
    expect(runs(command)).toBe(false)
  })
})
