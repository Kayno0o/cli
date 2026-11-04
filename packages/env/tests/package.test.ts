import { expect, test } from 'bun:test'
import pkg from '../package.json'

test('every file the package exports is shipped in its files list', () => {
  const shipped = pkg.files.map(entry => entry.replace(/\/$/, ''))

  for (const target of Object.values(pkg.exports)) {
    const path = target.replace(/^\.\//, '')

    expect(shipped.some(entry => path === entry || path.startsWith(`${entry}/`))).toBe(true)
  }
})
