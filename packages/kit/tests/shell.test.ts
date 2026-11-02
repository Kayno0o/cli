import { describe, expect, test } from 'bun:test'
import { braceExpand, commandsRun, isPlain, parseCommand, shellQuote, splitCommand, substitutions, tokenize, words } from '../src/shell'

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

  test('keeps the closers and backslashes a quoted last word holds', () => {
    expect(parseCommand('bun -e "f(/v\\d+/)"').args).toEqual(['-e', 'f(/v\\d+/)'])
    expect(parseCommand('(echo "f(x)")').args).toEqual(['f(x)'])
    expect(parseCommand('echo "a \\"b\\" \\$c \\\\"').args).toEqual(['a "b" $c \\'])
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

describe('comments', () => {
  test('end a line at a word start, whatever quote they hold', () => {
    const pieces = splitCommand('echo a # it\'s\ngit stash')

    expect(pieces.map(piece => piece.command.trim())).toEqual(['echo a', 'git stash'])
    expect(splitCommand('echo x # cat .env')[0]?.command.trim()).toBe('echo x')
  })

  test('stay text inside a word, a quote or a variable', () => {
    expect(splitCommand('echo a#b $# "x # y"')[0]?.command).toBe('echo a#b $# "x # y"')
  })
})

describe('heredocs', () => {
  test('end at a CRLF delimiter line', () => {
    const pieces = splitCommand('cat <<EOF\r\nbody\r\nEOF\r\ngit stash')

    expect(pieces.at(-1)?.command.trim()).toBe('git stash')
    expect(pieces[0]?.heredocs).toEqual(['\nbody\r\nEOF\r'])
  })
})

describe('ANSI-C quoting', () => {
  test('keeps an escaped quote inside the word, and decodes the escapes', () => {
    expect(splitCommand('echo $\'a\\\'b\'; git stash').map(piece => piece.command.trim())).toEqual(['echo $\'a\\\'b\'', 'git stash'])
    expect(tokenize('cat $\'.env\' $\'\\x2eenv\' $\'a\\nb\' $\'\\056env\'')).toEqual(['cat', '.env', '.env', 'a\nb', '.env'])
    expect(isPlain('echo $\'a\\\'b\'')).toBe(true)
  })
})

describe('words flags', () => {
  test('flags the unquoted globs and braces the shell would expand', () => {
    expect(words('ls .e* ".e*" {a,b} "{a,b}" x').map(word => [word.hasGlob, word.hasBrace])).toEqual([[false, false], [true, false], [false, false], [false, true], [false, false], [false, false]])
  })
})

describe('parseCommand wrappers', () => {
  test('skips keywords and the case label', () => {
    for (const text of ['then git stash', 'do git stash', 'else git stash', 'elif git stash', 'if git stash', 'while git stash', 'until git stash', '! git stash', '{ git stash', 'a) git stash', 'case x in a) git stash'])
      expect(parseCommand(text).program).toBe('git')
  })

  test('skips the options of a wrapper and the values they take', () => {
    const wrapped = ['sudo -u root git stash', 'sudo -g wheel -E git stash', 'sudo -- git stash', 'env -u X git stash', 'env -C /tmp git stash', 'env -S "git stash"', 'exec -a name git stash', 'timeout 5 git stash', 'timeout -k 1 -s KILL 5 git stash', 'timeout --signal=KILL 5 git stash', 'nice git stash', 'nice -n 5 git stash', 'nice -5 git stash', 'ionice -c 3 -n 1 git stash', 'setsid git stash', 'stdbuf -oL -e0 git stash', 'doas -u root git stash', 'chroot /srv git stash', 'busybox git stash', 'xargs -n1 -I{} git stash', 'nohup time -p git stash']

    for (const text of wrapped)
      expect(parseCommand(text)).toMatchObject({ program: 'git', args: ['stash'], isWrapped: true })
  })

  test('leaves what is no wrapper alone', () => {
    expect(parseCommand('echo sudo git')).toMatchObject({ program: 'echo', args: ['sudo', 'git'] })
    expect(parseCommand('env A=1 git stash')).toMatchObject({ program: 'git', assignments: ['A=1'] })
  })
})

describe('process substitutions', () => {
  test('are found outside quotes only', () => {
    expect(substitutions('diff <(git stash) >(cat .env) "<(no)" \'<(no)\'')).toEqual(['git stash', 'cat .env'])
  })
})

describe('commandsRun', () => {
  test('lists the command and everything it makes the shell run', () => {
    expect(commandsRun('echo ok')).toEqual(['echo ok'])
    expect(commandsRun('bash -c \'git stash\'')).toContain('git stash')
    expect(commandsRun('docker exec c sh -lc "a; b"')).toContain('a; b')
    expect(commandsRun('eval git stash')).toContain('git stash')
    expect(commandsRun('find . -exec git stash {} \\;')).toContain('git stash {}')
    expect(commandsRun('find . -exec sh -c \'echo "$0"\' {} +')).toContain('echo "$0"')
    expect(commandsRun('sh <<EOF\ngit stash\nEOF')).toContain('\ngit stash\nEOF')
    expect(commandsRun('bash <<< "git stash"')).toContain('git stash')
    expect(commandsRun('echo "git stash" | sh')).toContain('git stash')
    expect(commandsRun('(cat .env)')).toContain('cat .env')
    expect(commandsRun('echo $(echo $(git stash))')).toContain('git stash')
  })

  test('does not run what is plain data', () => {
    expect(commandsRun('echo git stash | cat')).toEqual(['echo git stash | cat'])
    expect(commandsRun('bash script.sh <<EOF\ngit stash\nEOF')).toHaveLength(1)
    expect(commandsRun('cat <<\'EOF\'\n$(git stash)\nEOF')).toHaveLength(1)
  })

  test('stops at a sane depth', () => {
    expect(commandsRun(`eval ${'eval '.repeat(30)}echo`).length).toBeLessThan(20)
  })
})

describe('braceExpand', () => {
  test('lists the words of a comma list', () => {
    expect(braceExpand('.{e,}nv')).toEqual(['.env', '.nv'])
    expect(braceExpand('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2'])
    expect(braceExpand('x{a,{b,c}}')).toEqual(['xa', 'xb', 'xc'])
    expect(braceExpand('.env{,.local}')).toEqual(['.env', '.env.local'])
  })

  test('leaves a word with no list, and a runaway one, as it is', () => {
    expect(braceExpand('plain')).toEqual(['plain'])
    expect(braceExpand('{a}')).toEqual(['{a}'])
    // eslint-disable-next-line no-template-curly-in-string -- the shell's own braces
    expect(braceExpand('${HOME}')).toEqual(['${HOME}'])

    const runaway = '{a,b}'.repeat(10)

    expect(braceExpand(runaway)).toEqual([runaway])
  })
})

describe('shellQuote', () => {
  test('leaves a safe word bare and single-quotes the rest', () => {
    expect(['src/a.ts', 'KEY=1', 'a@b:c,d', 'my file.ts', 'it\'s', '$HOME', '*.ts', '=ls', ''].map(shellQuote)).toEqual(['src/a.ts', 'KEY=1', 'a@b:c,d', '\'my file.ts\'', '\'it\'\\\'\'s\'', '\'$HOME\'', '\'*.ts\'', '\'=ls\'', '\'\''])
  })
})
