export const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const

export type Severity = (typeof SEVERITIES)[number]

/** One advisory as `audit` and `pkg audit` both list it: `ghsa` is read from the url and `fixed` is the version its range ends below, both absent when none applies. */
export interface AdvisoryRow {
  id: number
  ghsa?: string | undefined
  url: string
  title: string
  severity: Severity
  fixed?: string | undefined
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity)
}

/** Whether `--ignore` skips an advisory, by its GHSA or numeric id. */
export function isIgnored(advisory: Pick<AdvisoryRow, 'id' | 'ghsa'>, ignore: readonly string[]): boolean {
  return ignore.includes(advisory.ghsa ?? '') || ignore.includes(String(advisory.id))
}
