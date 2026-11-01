import type { AuditResult, Finding } from './types'
import { basename } from 'node:path'
import process from 'node:process'
import { capped, marked } from '@kaynooo/cli-kit'

const line = (finding: Finding) => `  ${marked(finding.level === 'error' ? 'problem' : 'warn', `[${finding.check}] ${finding.message}`, process.stdout)}`

export function errorsOf(result: AuditResult): Finding[] {
  return result.findings.filter(finding => finding.level === 'error')
}

// Each of the errors and warnings lists at most `limit` findings and ends on the count of the rest, the totals line counting them all.
function section(heading: string, findings: Finding[], limit: number): string[] {
  const { shown, footer } = capped(findings, limit)

  return findings.length === 0 ? [] : [heading, ...shown.map(line), ...footer === undefined ? [] : [`  ${footer}`], '']
}

export function render(result: AuditResult, limit = Number.POSITIVE_INFINITY): string {
  const errors = errorsOf(result)
  const warnings = result.findings.filter(finding => finding.level === 'warn')

  if (result.findings.length === 0)
    return marked('ok', `${basename(result.root)}: compose ${result.composeFiles.join(', ')} and release.config.ts agree.`, process.stdout)

  return [
    ...section('Errors', errors, limit),
    ...section('Warnings', warnings, limit),
    `${errors.length} error(s), ${warnings.length} warning(s)`,
  ].join('\n')
}
