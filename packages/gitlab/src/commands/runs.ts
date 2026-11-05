import type { ExitRow } from '@kaynooo/cli-kit'
import type { PipelineListing } from '../pipelines'
import { badge, formatAge, formatSeconds, hyperlink, jsonOption, limitOf, limitOptions, moreFooter, parse, printJson, table, truncate } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { resolveCommit, subjects } from '../git'
import { FINISHED, pipelinesOn, recentPipelines } from '../pipelines'

const usage = `gl runs [--sha <ref>] [--branch <name>] [-n <rows> | --full] [--json]

Lists recent pipelines with their ref, source, commit, duration and age, the commit's subject when the clone has it, ten by default with the count of the rest (--full for all of them).`

const exits: ExitRow[] = [[0, 'it listed them'], [1, 'GitLab or git cannot be read'], [2, 'a usage error']]

const DEFAULT_LIMIT = 10

const options = {
  ...limitOptions(DEFAULT_LIMIT),
  sha: { type: 'string', short: 's', description: 'only the pipelines of this commit' },
  branch: { type: 'string', short: 'b', description: 'only the pipelines of this branch or tag' },
  json: jsonOption(),
  ...repoOption,
} as const

const TITLE_WIDTH = 70

// Every pipeline of a commit, cut to `limit` with the count of the rest.
async function onCommit(sha: string, limit: number, repo: string | undefined, ref: string | undefined): Promise<PipelineListing> {
  const found = await pipelinesOn(sha, repo, ref)

  return { pipelines: found.slice(0, limit), more: Math.max(0, found.length - limit), exact: true }
}

export async function runs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { exits })

  const { values } = parsed
  const limit = limitOf(values, DEFAULT_LIMIT)
  const { pipelines: list, more, exact } = values.sha === undefined
    ? await recentPipelines(limit, values.repo, values.branch)
    : await onCommit(await resolveCommit(values.sha), limit, values.repo, values.branch)
  const titles = await subjects([...new Set(list.map(pipeline => pipeline.sha))])

  if (values.json === true) {
    printJson(list.map(pipeline => ({ id: pipeline.id, number: pipeline.iid, status: pipeline.status, ref: pipeline.ref, source: pipeline.source, sha: pipeline.sha, created: pipeline.created_at, updated: pipeline.updated_at, title: titles.get(pipeline.sha) ?? null, url: pipeline.web_url })))

    return 0
  }

  if (list.length === 0) {
    console.log('no pipeline')

    return 0
  }

  // The list carries no duration, so a finished pipeline's is the time from its creation to its last update.
  console.log(table([
    ['ID', 'STATUS', 'REF', 'SOURCE', 'SHA', 'TOOK', 'CREATED', 'TITLE'],
    ...list.map(pipeline => [hyperlink(String(pipeline.id), pipeline.web_url, process.stdout), badge(pipeline.status, process.stdout), pipeline.ref, pipeline.source, pipeline.sha.slice(0, 7), FINISHED.has(pipeline.status) ? formatSeconds((Date.parse(pipeline.updated_at) - Date.parse(pipeline.created_at)) / 1000) : '-', formatAge(pipeline.created_at), truncate(titles.get(pipeline.sha) ?? '', TITLE_WIDTH)]),
  ], { header: true }))

  if (more > 0)
    console.log(exact ? moreFooter(more) : `${more}+ more, rerun with --full`)

  return 0
}
