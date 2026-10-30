import type { Options } from '@kaynooo/cli-kit'

export const repoOption = {
  repo: { type: 'string', short: 'r', description: 'group/project path of the project, instead of the one the remote points at' },
} as const satisfies Options
