import { badUsage, wholeNumber } from './args'

// Short flags mean one thing across the bins: `-n` how many rows, lines or items to show (some bins keep `-n` for a count of their own, which their help words: `sub -n` matches expected, `base proof -n` runs, `slot -n` slots), `-q` quiet, except where it is a query (`pick -q`, which has no quiet mode).
// The `--limit` and `--full` flags every listing words alike, `fallback` being the rows shown without either.
export function limitOptions(fallback: number) {
  return {
    limit: { type: 'string', short: 'n', description: `show at most this many rows, the rest counted (${fallback})` },
    full: { type: 'boolean', description: 'show every row' },
  } as const
}

// How many rows to print: --limit, the fallback without one, and every row (Infinity) with --full or, when `json` is set, whenever --limit is not given, so JSON is never cut on its own.
export function limitOf(values: { limit?: string | undefined, full?: boolean | undefined, json?: boolean | undefined }, fallback: number): number {
  if (values.full === true && values.limit !== undefined)
    badUsage('--limit and --full exclude each other')

  if (values.full === true || (values.json === true && values.limit === undefined))
    return Number.POSITIVE_INFINITY

  return wholeNumber(values.limit, 'limit', fallback)
}

export function moreFooter(more: number): string {
  return `${more} more, rerun with --full`
}

// The first `limit` rows and, when some are left out, the footer counting them: `12 more, rerun with --full`.
export function capped<T>(rows: readonly T[], limit: number): { shown: T[], footer: string | undefined } {
  const more = rows.length - limit

  return more > 0 ? { shown: rows.slice(0, limit), footer: moreFooter(more) } : { shown: [...rows], footer: undefined }
}
