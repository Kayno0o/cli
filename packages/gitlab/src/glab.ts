import { upTo } from '@kaynooo/cli-kit'
import { $ } from 'bun'

// Every GitLab call goes through `glab api`, which owns the login and fills :id from the cwd's remote; --repo names the project instead.
function projectPath(repo: string | undefined): string {
  return repo === undefined ? 'projects/:id' : `projects/${encodeURIComponent(repo)}`
}

async function request(path: string, repo: string | undefined): Promise<string> {
  const endpoint = `${projectPath(repo)}/${path}`
  let result

  try {
    result = await $`glab api ${endpoint}`.quiet().nothrow()
  }
  catch (error) {
    throw new Error(`glab api ${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
  }

  // glab prints GitLab's error object on stdout and its own summary on stderr.
  if (result.exitCode !== 0)
    throw new Error(`glab api ${endpoint}: ${upTo(result.stderr.toString().trim(), '\n') || result.stdout.toString().trim() || `exit ${result.exitCode}`}`)

  return result.stdout.toString()
}

export async function projectApi<T>(path: string, repo?: string): Promise<T> {
  const text = await request(path, repo)

  try {
    return JSON.parse(text) as T
  }
  catch {
    throw new Error(`glab api ${path}: ${upTo(text.trim(), '\n') || 'empty answer'}`)
  }
}

export async function projectApiText(path: string, repo?: string): Promise<string> {
  return request(path, repo)
}
