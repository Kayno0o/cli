const OR_SPLIT = /\s+OR\s+/i
const AND_SPLIT = /\s+AND\s+/i
const WITH_EXCEPTION = /\s+WITH\s+\S+$/i
const PARENS = /[()]/g

// Whether an SPDX expression is covered by the allowlist: one alternative of an OR must be, and every term of an AND.
export function isLicenseAllowed(expression: string, allowed: string[]): boolean {
  const known = new Set(allowed.map(each => each.toLowerCase()))

  return expression.replace(PARENS, ' ').trim().split(OR_SPLIT).some(alternative => alternative.split(AND_SPLIT).every(term => known.has(term.replace(WITH_EXCEPTION, '').trim().toLowerCase())))
}
