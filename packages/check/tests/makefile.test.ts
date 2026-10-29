import { describe, expect, test } from 'bun:test'
import { declarePhony } from '../src/makefile'

describe('declarePhony', () => {
  test('declares every target once, sorted, in place of the old declaration', () => {
    const { content, targets } = declarePhony('.PHONY: old\n\nbuild: deps\n\tgo build\n\ndeps:\n\tgo get\n\nbuild:\n\techo again\n')

    expect(targets).toEqual(['build', 'deps'])
    expect(content).toBe('.PHONY: build deps\n\nbuild: deps\n\tgo build\n\ndeps:\n\tgo get\n\nbuild:\n\techo again\n')
  })

  test('leaves variables set with := or ::= out, and keeps double-colon targets', () => {
    expect(declarePhony('CC:=gcc\nLD::=ld\nall:: CC\n\techo $(CC)\n').targets).toEqual(['all'])
  })

  test('collapses runs of blank lines and trims the ends', () => {
    expect(declarePhony('\n\nrun:\n\tbun x\n\n\n\ntest:\n\tbun test\n\n\n').content).toBe('.PHONY: run test\n\nrun:\n\tbun x\n\ntest:\n\tbun test\n')
  })

  test('adds no declaration to a Makefile without targets', () => {
    expect(declarePhony('include other.mk\n')).toEqual({ content: 'include other.mk\n', targets: [] })
  })
})
