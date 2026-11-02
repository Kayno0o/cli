const OR = /\s*\|\|\s*/
const WHITESPACE = /\s+/
const PRERELEASE = /-/
const PART = String.raw`(?:\d+|[xX*])`
const COMPARATOR = new RegExp(String.raw`^(?:[<>]=?|=|\^|~>?)?v?${PART}(?:\.${PART}){0,2}(?:-[\w.-]+)?(?:\+[\w.-]+)?$`)
const BOUND = /^(<=|>=|[<>=])?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/

export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

// Whether the text is a semver range; Bun.semver.satisfies treats an unparsable one as matching everything.
export function isRange(text: string): boolean {
  if (text.trim() === '')
    return true

  return text.split(OR).every((alternative) => {
    const words = alternative.trim().split(WHITESPACE)

    return words.every((word, index) => word === '-' ? index > 0 && index < words.length - 1 : COMPARATOR.test(word))
  })
}

function compare(version: string, word: string): boolean | undefined {
  const bound = BOUND.exec(word)

  if (bound === null)
    return undefined

  const order = Bun.semver.order(version, bound[2] ?? '')

  const operator = bound[1] ?? '='

  if (operator === '<')
    return order < 0

  if (operator === '<=')
    return order <= 0

  if (operator === '>')
    return order > 0

  return operator === '>=' ? order >= 0 : order === 0
}

// Whether the version is in the range, a prerelease counting as it does for an advisory: `1.0.0-beta.1` is below `<1.2.0`, which Bun.semver.satisfies leaves out.
export function inRange(version: string, range: string): boolean {
  if (Bun.semver.satisfies(version, range))
    return true

  if (!PRERELEASE.test(version))
    return false

  return range.split(OR).some(alternative => alternative.trim().split(WHITESPACE).every(word => compare(version, word) ?? Bun.semver.satisfies(version, word)))
}
