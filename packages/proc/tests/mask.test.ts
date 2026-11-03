import { expect, test } from 'bun:test'
import { maskArgs, maskEnviron, maskText, maskValue } from '../src/mask'

test('a secret-looking name masks the whole value', () => {
  expect(maskValue('DB_PASSWORD', 'hunter2')).toBe('***')
  expect(maskValue('GITHUB_TOKEN', 'x')).toBe('***')
  expect(maskValue('PATH', '/usr/bin:/bin')).toBe('/usr/bin:/bin')
  expect(maskValue('EMPTY_TOKEN', '')).toBe('')
})

test('a secret shape is masked whatever the name', () => {
  expect(maskValue('DATABASE_URL', 'postgres://user:s3cr3t@db:5432/app')).toBe('postgres://user:***@db:5432/app')
  expect(maskValue('NOTE', `use ghp_${'a'.repeat(30)} here`)).toBe('use *** here')
  expect(maskValue('X', `eyJhbGciOi.eyJzdWIiOi.abcdef`)).toBe('***')
  expect(maskText('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe('***')
})

test('maskEnviron keeps names and plain values', () => {
  expect(maskEnviron([['HOME', '/home/kay'], ['API_KEY', 'abc']])).toEqual([['HOME', '/home/kay'], ['API_KEY', '***']])
})

test('maskArgs masks a flag value, joined or in the next word', () => {
  expect(maskArgs(['app', '--password=abc', '--port=80', '--token', 'xyz', '--verbose', 'API_KEY=1', 'TZ=UTC'])).toEqual(['app', '--password=***', '--port=80', '--token', '***', '--verbose', 'API_KEY=***', 'TZ=UTC'])
})
