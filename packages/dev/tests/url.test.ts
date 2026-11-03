import { describe, expect, test } from 'bun:test'
import { urlParts } from '../src/url'

describe('urlParts', () => {
  test('splits every part and decodes the query', () => {
    expect(urlParts('https://u:p%40ss@example.com:8443/a%20b/c?q=x%26y&page=2&q=z+w&empty=#top%21')).toEqual({
      href: 'https://u:p%40ss@example.com:8443/a%20b/c?q=x%26y&page=2&q=z+w&empty=#top%21',
      protocol: 'https',
      username: 'u',
      password: 'p@ss',
      host: 'example.com:8443',
      hostname: 'example.com',
      port: '8443',
      pathname: '/a b/c',
      query: [{ key: 'q', value: 'x&y' }, { key: 'page', value: '2' }, { key: 'q', value: 'z w' }, { key: 'empty', value: '' }],
      hash: 'top!',
    })
  })

  test('a plain URL has empty optional parts and no query', () => {
    expect(urlParts('http://example.com')).toMatchObject({ protocol: 'http', port: '', pathname: '/', query: [], hash: '', username: '' })
  })

  test('keeps a malformed escape as is', () => {
    expect(urlParts('http://example.com/100%').pathname).toBe('/100%')
  })

  test('trims the text and refuses a URL without a scheme', () => {
    expect(urlParts(' https://example.com/\n').hostname).toBe('example.com')
    expect(() => urlParts('example.com/path')).toThrow('example.com/path is not a URL')
  })
})
