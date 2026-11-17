import { describe, expect, test } from 'bun:test'
import { fallbackOf, families } from '../src/fonts'

describe('fallbackOf', () => {
  test('a named family not drawn is not available', () => {
    expect(fallbackOf('Inter, "Helvetica Neue", sans-serif', 'DejaVu Sans', false)).toBe('Inter, Helvetica Neue are not available')
    expect(fallbackOf('Inter, sans-serif', 'Inter', false)).toBeUndefined()
    expect(fallbackOf('"Segoe UI", Arial, sans-serif', 'arial', false)).toBeUndefined()
  })

  test('a generic stack is fine unless it draws monospace text it did not ask for', () => {
    expect(fallbackOf('system-ui, -apple-system, "Segoe UI", sans-serif', 'Adwaita Mono', true)).toBe('system-ui resolves to a monospace font')
    expect(fallbackOf('system-ui, sans-serif', 'Adwaita Sans', false)).toBeUndefined()
    expect(fallbackOf('ui-monospace, monospace', 'Adwaita Mono', true)).toBeUndefined()
  })

  test('families come unquoted, in order', () => {
    expect(families(' "Segoe UI" , \'Inter\',sans-serif')).toEqual(['Segoe UI', 'Inter', 'sans-serif'])
  })
})
