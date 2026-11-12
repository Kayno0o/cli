import { describe, expect, test } from 'bun:test'
import { parseLine } from '../src/shell'

const texts = (line: string) => parseLine(line).map(step => step.command.words.map(word => word.text))

describe('parseLine', () => {
  test('splits on pipes and control operators', () => {
    const steps = parseLine('a -x | b && c || d; e &')

    expect(steps.map(step => step.command.words[0]?.text)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(steps.map(step => step.next)).toEqual(['|', '&&', '||', ';', '&'])
  })

  test('removes quotes and escapes but keeps the offsets of the source', () => {
    const [step] = parseLine('grep "a b" \'c d\' e\\ f')

    expect(step?.command.words.map(word => word.text)).toEqual(['grep', 'a b', 'c d', 'e f'])
    expect(step?.command.words[1]).toMatchObject({ start: 5, end: 10 })
  })

  test('reads redirects with their descriptor and target', () => {
    const [step] = parseLine('cmd a > out 2>&1 <in')

    expect(step?.command.words.map(word => word.text)).toEqual(['cmd', 'a'])
    expect(step?.command.redirects.map(redirect => [redirect.fd, redirect.op, redirect.target?.text])).toEqual([[undefined, '>', 'out'], ['2', '>&', '1'], [undefined, '<', 'in']])
  })

  test('reads &> and &>> as redirections, not a background operator', () => {
    const steps = parseLine('ls -l &> out.txt; ls &>> log')

    expect(steps.map(step => step.next)).toEqual([';', undefined])
    expect(steps.map(step => step.command.redirects.map(redirect => [redirect.op, redirect.target?.text]))).toEqual([[['&>', 'out.txt']], [['&>>', 'log']]])
  })

  test('collects leading assignments apart from the words', () => {
    const [step] = parseLine('A=1 B="x y" cmd C=3')

    expect(step?.command.assigns.map(word => word.text)).toEqual(['A=1', 'B=x y'])
    expect(step?.command.words.map(word => word.text)).toEqual(['cmd', 'C=3'])
  })

  test('keeps substitutions in the word and hands their inside over', () => {
    const [step] = parseLine('echo $(date +%s) "$(a b)" `uname -r`')

    expect(step?.command.words.map(word => word.text)).toEqual(['echo', '$(date +%s)', '$(a b)', '`uname -r`'])
    expect(step?.command.substitutions).toEqual(['date +%s', 'a b', 'uname -r'])
  })

  test('does not split on operators inside quotes and ignores comments', () => {
    expect(texts('echo "a | b" \'&&\' # not this')).toEqual([['echo', 'a | b', '&&']])
  })

  test('survives an unclosed quote', () => {
    expect(texts('echo "abc')).toEqual([['echo', 'abc']])
  })
})
