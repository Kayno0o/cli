import { describe, expect, test } from 'bun:test'
import { scriptArgs } from '../src/argv'

const SCRIPT = '/bin/gp.js'

describe('scriptArgs', () => {
  test('puts back the -- Bun dropped right after the script', () => {
    expect(scriptArgs(['--tags'], ['bun', '--no-env-file', SCRIPT, '--', '--tags'], SCRIPT)).toEqual(['--', '--tags'])
  })

  test('leaves the arguments alone when nothing was dropped', () => {
    expect(scriptArgs(['a', '--', 'b'], ['bun', SCRIPT, 'a', '--', 'b'], SCRIPT)).toEqual(['a', '--', 'b'])
    expect(scriptArgs(['--tags'], ['bun', SCRIPT, '--tags'], SCRIPT)).toEqual(['--tags'])
  })

  test('a command line it cannot match to the script gives the arguments as Bun passed them', () => {
    expect(scriptArgs(['--tags'], ['/$bunfs/root/gp', '--', '--tags'], '/$bunfs/root/gp-other')).toEqual(['--tags'])
    expect(scriptArgs(['--tags'], undefined, SCRIPT)).toEqual(['--tags'])
    expect(scriptArgs(['x'], ['bun', SCRIPT, '--', 'y'], SCRIPT)).toEqual(['x'])
  })

  test('this process reads its own command line', () => {
    expect(scriptArgs()).toEqual(process.argv.slice(2))
  })
})
