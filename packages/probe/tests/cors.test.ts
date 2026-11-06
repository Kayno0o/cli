import { describe, expect, test } from 'bun:test'
import { corsVerdict } from '../src/cors'

const ORIGIN = 'https://app.test'
const JSON_POST = { origin: ORIGIN, method: 'POST', headers: ['content-type'] }
const ALLOWING = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'Content-Type', 'vary': 'Origin', 'server': 'x' }

describe('corsVerdict', () => {
  test('the origin and every header allowed lets the request through, showing only the CORS headers', () => {
    expect(corsVerdict(204, ALLOWING, JSON_POST)).toEqual({ allowed: true, reasons: [], warnings: [], headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'Content-Type', 'vary': 'Origin' } })
  })

  test('a status out of 2xx, no or another origin are each a reason', () => {
    expect(corsVerdict(404, ALLOWING, JSON_POST).reasons).toEqual(['the preflight answered 404, a browser wants a 2xx'])
    expect(corsVerdict(204, {}, { ...JSON_POST, headers: [] }).reasons).toEqual(['no access-control-allow-origin'])
    expect(corsVerdict(204, { ...ALLOWING, 'access-control-allow-origin': 'https://other.test' }, JSON_POST).reasons).toEqual([`access-control-allow-origin is https://other.test, not ${ORIGIN}`])
  })

  test('a method other than GET, HEAD or POST has to be listed, or covered by *', () => {
    const put = { ...JSON_POST, method: 'PUT' }

    expect(corsVerdict(204, ALLOWING, put).reasons).toEqual(['no access-control-allow-methods, which PUT needs'])
    expect(corsVerdict(204, { ...ALLOWING, 'access-control-allow-methods': 'GET, DELETE' }, put).reasons).toEqual(['access-control-allow-methods (GET, DELETE) does not list PUT'])
    expect(corsVerdict(204, { ...ALLOWING, 'access-control-allow-methods': 'get, put' }, put).allowed).toBe(true)
    expect(corsVerdict(204, { ...ALLOWING, 'access-control-allow-methods': '*' }, put).allowed).toBe(true)
  })

  test('every header has to be listed, a * covering them all but authorization', () => {
    const request = { ...JSON_POST, headers: ['Content-Type', 'X-Trace', 'Authorization'] }

    expect(corsVerdict(204, ALLOWING, request).reasons).toEqual(['access-control-allow-headers does not cover x-trace, authorization'])
    expect(corsVerdict(204, { ...ALLOWING, 'access-control-allow-headers': '*' }, request).reasons).toEqual(['access-control-allow-headers does not cover authorization'])
    expect(corsVerdict(204, { ...ALLOWING, 'access-control-allow-headers': '*, authorization' }, request).allowed).toBe(true)
  })

  test('a * origin with credentials and an echoed origin without vary are warned about', () => {
    expect(corsVerdict(204, { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' }, JSON_POST)).toMatchObject({ allowed: true, warnings: ['access-control-allow-credentials comes with a * wildcard, which a request with cookies or auth does not get'] })
    expect(corsVerdict(204, { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'content-type' }, JSON_POST).warnings).toEqual(['the allowed origin varies but vary lacks origin: a cache may hand this answer to another origin'])
  })
})
