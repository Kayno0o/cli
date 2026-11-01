import { formatAge, formatSeconds, jsonOption, parse, printJson, table, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { resolveCommit, subjects } from '../git'
import { FINISHED, pipelinesOn, recentPipelines } from '../pipelines'

const usage = `gl runs [--sha <ref>]

Lists recent pipelines with their ref, source, commit, duration and age, the commit's subject when the clone has it.`

const options = {
  limit: { type: 'string', short: 'n', description: 'how many pipelines (10, at most 100)' },
  sha: { type: 'string', short: 's', description: 'only the pipelines of this commit' },
  branch: { type: 'string', short: 'b', description: 'only the pipelines of this branch or tag' },
  json: jsonOption(),
  ...repoOption,
} as const

const TITLE_WIDTH = 70

export async function runs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values } = parsed
  const limit = wholeNumber(values.limit, 'limit', 10)
  const found = values.sha === undefined
    ? await recentPipelines(limit, values.repo, values.branch)
    : await pipelinesOn(await resolveCommit(values.sha), values.repo, values.branch)
  const list = found.slice(0, limit)
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
    ...list.map(pipeline => [String(pipeline.id), pipeline.status, pipeline.ref, pipeline.source, pipeline.sha.slice(0, 7), FINISHED.has(pipeline.status) ? formatSeconds((Date.parse(pipeline.updated_at) - Date.parse(pipeline.created_at)) / 1000) : '-', formatAge(pipeline.created_at), truncate(titles.get(pipeline.sha) ?? '', TITLE_WIDTH)]),
  ]))

  return 0
}
