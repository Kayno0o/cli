import { describe, expect, test } from 'bun:test'
import { isPlain, parseCommand, splitCommand, substitutions, tokenize, words } from '../src/shell'

describe('splitCommand', () => {
  test('splits on separators outside quotes, keeping each one', () => {
    const pieces = splitCommand('a "x;y" && b | c 2>&1; d & e')

    expect(pieces.map(piece => piece.text.trim())).toEqual(['a "x;y"', 'b', 'c 2>&1', 'd', 'e'])
    expect(pieces.map(piece => piece.separator)).toEqual(['&&', '|', ';', '&', ''])
  })

  test('leaves heredoc bodies out of the command, several on one line included', () => {
    const [first, second] = splitCommand('cat > a <<\'A\' > b <<B\nnot; a | command\nA\nnor this\nB\ngit status')

    expect(first?.command).toBe('cat > a <<\'A\' > b <<B')
    expect(first?.text).toContain('nor this')
    expect(second?.command.trim()).toBe('git status')
  })
})

describe('parseCommand', () => {
  test('finds the program past wrappers, assignments and subshells', () => {
    expect(parseCommand('(FOO=1 sudo -E /usr/bin/git stash)')).toEqual({ program: 'git', args: ['stash'], assignments: ['FOO=1'], isWrapped: true })
  })
})

describe('words', () => {
  test('removes quotes and marks quoted whitespace as prose', () => {
    expect(tokenize('git commit -m "a b" \'c\'')).toEqual(['git', 'commit', '-m', 'a b', 'c'])
    expect(words('cat ".env" "a .env"').map(word => word.isProse)).toEqual([false, false, true])
  })
})

describe('substitutions', () => {
  test('finds what the shell runs, in double quotes and unquoted heredocs, never in single quotes', () => {
    expect(substitutions('echo "$(ssh a)" `git stash` \'$(no)\' \\$(no) && cat <<EOF\n$(rm x)\nEOF\ncat <<\'EOF\'\n$(no)\nEOF')).toEqual(['ssh a', 'git stash', 'rm x'])
  })

  test('reads the outermost one whole, nested substitutions and quoted parentheses included', () => {
    expect(substitutions('echo $(ssh h $(echo a)) $(psql -c \'DELETE FROM t WHERE x = ")"\')')).toEqual(['ssh h $(echo a)', 'psql -c \'DELETE FROM t WHERE x = ")"\''])
    expect(substitutions('cat <<EOF\ndon\'t $(git stash)\nEOF')).toEqual(['git stash'])
  })
})

describe('isPlain', () => {
  test('refuses redirects, substitutions and subshells outside single quotes', () => {
    expect(['bun test --filter "a b"', 'echo \'$(x) > y\''].every(isPlain)).toBe(true)
    expect(['bun test > log', 'echo "$(date)"', 'echo `date`', '(cd x)', 'echo "open'].some(isPlain)).toBe(false)
  })
})
