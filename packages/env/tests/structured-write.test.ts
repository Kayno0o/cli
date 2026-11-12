import { describe, expect, test } from 'bun:test'
import { setStructured, unsetStructured } from '../src/structured-write'

// Each edit changes the key's own span and nothing else of the file.
const edits: [name: string, text: string, key: string, value: string | undefined, expected: string][] = [
  ['an added key leaves inline siblings inline', '{\n  "a": {"x": 1, "y": [1,2]},\n  "b": {"p":1},\n  "c": 3\n}\n', 'a.z', 'v', '{\n  "a": {"x": 1, "y": [1,2], "z": "v"},\n  "b": {"p":1},\n  "c": 3\n}\n'],
  ['a removed key leaves the object before it inline', '{\n  "a": {"x": 1, "y": [1,2]},\n  "b": {"p":1},\n  "c": 3\n}\n', 'c', undefined, '{\n  "a": {"x": 1, "y": [1,2]},\n  "b": {"p":1}\n}\n'],
  ['a minified file stays minified', '{"name":"x","version":"1.0.0"}', 'private', 'yes', '{"name":"x","version":"1.0.0","private":"yes"}'],
  ['a key added after a commented line keeps the comment on its line', '{\n  "a": 1, // one\n  "b": 2 // two\n}\n', 'c', 'z', '{\n  "a": 1, // one\n  "b": 2, // two\n  "c": "z"\n}\n'],
  ['a trailing comma is kept', '{\n  "a": 1,\n  "b": 2,\n}\n', 'c', 'z', '{\n  "a": 1,\n  "b": 2,\n  "c": "z"\n}\n'],
  ['nested keys added to a CRLF file keep its line endings', '{\r\n  "a": {\r\n    "b": 1\r\n  }\r\n}\r\n', 'a.c.d', 'z', '{\r\n  "a": {\r\n    "b": 1,\r\n    "c": {\r\n      "d": "z"\r\n    }\r\n  }\r\n}\r\n'],
  ['a key starting with $ is a key', '{\n  "$schema": "old"\n}\n', '$schema', 'new', '{\n  "$schema": "new"\n}\n'],
  ['removing a block scalar keeps the comment after it', 'a: |\n  x\n# about b\nb: 1\n', 'a', undefined, '# about b\nb: 1\n'],
  ['removing the last block scalar keeps the blank line and comment after it', 'a: 1\nb: |\n  x\n\n# tail\n', 'b', undefined, 'a: 1\n\n# tail\n'],
  ['a numeric key is set in place', '200: ok\n404: no\n', '404', 'x', '200: ok\n404: x\n'],
  ['an empty value gets one after its colon', 'a: 1\nb:\nc: 2\n', 'b', 'x', 'a: 1\nb: x\nc: 2\n'],
  ['an empty value keeps its comment', 'a: 1\nb: # note\nc: 2\n', 'b', 'x', 'a: 1\nb: x # note\nc: 2\n'],
  ['a key added to a CRLF YAML file ends in CRLF', 'k: v\r\nz: 1\r\n', 'y', 'x', 'k: v\r\nz: 1\r\ny: x\r\n'],
]

describe('structured edits', () => {
  for (const [what, text, key, value, expected] of edits) {
    test(what, () => {
      const name = text.startsWith('{') ? 'a.json' : 'a.yaml'

      expect(value === undefined ? unsetStructured(name, text, key) : setStructured(name, text, key, value)).toBe(expected)
    })
  }

  test('a TOML date is a value to replace, not keys', () => {
    expect(setStructured('a.toml', 'd = 1979-05-27T07:32:00Z\n', 'd', 'x')).toBe('d = "x"\n')
  })

  test('a YAML alias is refused, not duplicated', () => {
    expect(() => setStructured('a.yaml', 'a: &x 1\nb: *x\n', 'b', 'z')).toThrow('b is an alias')
  })
})
