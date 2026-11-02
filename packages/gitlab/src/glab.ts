import { runTool, upTo } from '@kaynooo/cli-kit'

// How long one glab call may take before it is given up; the wait loops poll again.
const GLAB_MS = 60_000

// Every GitLab call goes through `glab api`, which owns the login and fills :id from the cwd's remote; --repo names the project instead.
function projectPath(repo: string | undefined): string {
  return repo === undefined ? 'projects/:id' : `projects/${encodeURIComponent(repo)}`
}

async function request(path: string, repo: string | undefined): Promise<string> {
  const endpoint = `${projectPath(repo)}/${path}`
  const result = await runTool(`glab api ${endpoint}`, ['glab', 'api', endpoint], { timeoutMs: GLAB_MS })

  // glab prints GitLab's error object on stdout and its own summary on stderr.
  if (result.code !== 0)
    throw new Error(`glab api ${endpoint}: ${upTo(result.stderr.trim(), '\n') || result.stdout.trim() || `exit ${result.code}`}`)

  return result.stdout
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
