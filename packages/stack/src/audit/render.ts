import type { AuditResult, Finding } from './types'
import { basename } from 'node:path'

const line = (finding: Finding) => `  ${finding.level === 'error' ? 'x' : '!'} [${finding.check}] ${finding.message}`

export function errorsOf(result: AuditResult): Finding[] {
  return result.findings.filter(finding => finding.level === 'error')
}

export function render(result: AuditResult): string {
  const errors = errorsOf(result)
  const warnings = result.findings.filter(finding => finding.level === 'warn')

  if (result.findings.length === 0)
    return `ok ${basename(result.root)}: compose ${result.composeFiles.join(', ')} and release.config.ts agree.`

  return [
    ...(errors.length > 0 ? ['Errors', ...errors.map(line), ''] : []),
    ...(warnings.length > 0 ? ['Warnings', ...warnings.map(line), ''] : []),
    `${errors.length} error(s), ${warnings.length} warning(s)`,
  ].join('\n')
}
