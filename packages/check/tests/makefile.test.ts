import { describe, expect, test } from 'bun:test'
import { declarePhony } from '../src/makefile'

describe('declarePhony', () => {
  test('declares every target once, sorted, in place of the old declaration, keeping what it declared', () => {
    const { content, targets } = declarePhony('.PHONY: old\n\nbuild: deps\n\tgo build\n\ndeps:\n\tgo get\n\nbuild:\n\techo again\n')

    expect(targets).toEqual(['build', 'deps', 'old'])
    expect(content).toBe('.PHONY: build deps old\n\nbuild: deps\n\tgo build\n\ndeps:\n\tgo get\n\nbuild:\n\techo again\n')
  })

  test('reads every target of a rule naming several, and leaves the declaration where it stood', () => {
    const { content, targets } = declarePhony('.DEFAULT_GOAL := help\n.PHONY: help check fix patch minor major\n\nhelp:\n\t@echo h\n\npatch minor major:\n\t@echo $@\n')

    expect(targets).toEqual(['check', 'fix', 'help', 'major', 'minor', 'patch'])
    expect(content).toBe('.DEFAULT_GOAL := help\n.PHONY: check fix help major minor patch\n\nhelp:\n\t@echo h\n\npatch minor major:\n\t@echo $@\n')
  })

  test('leaves variables set with := or ::= out, and keeps double-colon targets', () => {
    expect(declarePhony('CC:=gcc\nLD::=ld\nall:: CC\n\techo $(CC)\n').targets).toEqual(['all'])
  })

  test('collapses runs of blank lines and trims the ends', () => {
    expect(declarePhony('\n\nrun:\n\tbun x\n\n\n\ntest:\n\tbun test\n\n\n').content).toBe('.PHONY: run test\n\nrun:\n\tbun x\n\ntest:\n\tbun test\n')
  })

  test('replaces a .PHONY line continued over several lines whole', () => {
    const { content } = declarePhony('.PHONY: a b \\\n  c d\n\na:\n\ttrue\n\nb:\n\ttrue\n')

    expect(content).toBe('.PHONY: a b c d\n\na:\n\ttrue\n\nb:\n\ttrue\n')
  })

  test('leaves out a target that is a file that exists or that depends on files', () => {
    const { targets } = declarePhony('node_modules: package.json\n\tbun install\n\nbuild: src/main.c\n\tcc\n\ndist:\n\tmkdir dist\n\ntest:\n\ttrue\n', name => name === 'dist')

    expect(targets).toEqual(['test'])
  })

  test('adds no declaration to a Makefile without targets', () => {
    expect(declarePhony('include other.mk\n')).toEqual({ content: 'include other.mk\n', targets: [] })
  })
})
