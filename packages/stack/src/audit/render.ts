import type { AuditResult, Finding } from './types'
import { basename } from 'node:path'
import process from 'node:process'
import { marked } from '@kaynooo/cli-kit'

const line = (finding: Finding) => `  ${marked(finding.level === 'error' ? 'problem' : 'warn', `[${finding.check}] ${finding.message}`, process.stdout)}`

export function errorsOf(result: AuditResult): Finding[] {
  return result.findings.filter(finding => finding.level === 'error')
}

export function render(result: AuditResult): string {
  const errors = errorsOf(result)
  const warnings = result.findings.filter(finding => finding.level === 'warn')

  if (result.findings.length === 0)
    return marked('ok', `${basename(result.root)}: compose ${result.composeFiles.join(', ')} and release.config.ts agree.`, process.stdout)

  return [
    ...(errors.length > 0 ? ['Errors', ...errors.map(line), ''] : []),
    ...(warnings.length > 0 ? ['Warnings', ...warnings.map(line), ''] : []),
    `${errors.length} error(s), ${warnings.length} warning(s)`,
  ].join('\n')
}
