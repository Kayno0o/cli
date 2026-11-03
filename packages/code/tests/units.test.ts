import { describe, expect, test } from 'bun:test'
import { worstUnit } from '../src/units'

describe('worstUnit', () => {
  test('picks the declaration with the most decision points', () => {
    const text = 'function a() {\n  return 1\n}\n\nfunction b(x) {\n  if (x && x > 1) {\n    return 2\n  }\n}\n'

    expect(worstUnit(text)).toEqual({ name: 'function b(x) {', line: 5, complexity: 3 })
  })

  test('opens a class into its methods, and reads indentation-based languages', () => {
    const klass = 'class A {\n  quiet() {\n    return 1\n  }\n\n  busy(x) {\n    if (x) {\n      return 2\n    }\n  }\n}\n'
    const python = 'def a():\n    return 1\n\ndef b(x):\n    if x and x > 1:\n        return 2\n'

    expect(worstUnit(klass)).toMatchObject({ name: 'busy(x) {', line: 6, complexity: 2 })
    expect(worstUnit(python)).toMatchObject({ name: 'def b(x):', line: 4, complexity: 3 })
  })

  test('has nothing to name in an empty file', () => {
    expect(worstUnit('')).toBeUndefined()
  })
})
