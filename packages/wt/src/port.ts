// The dev server port of a worktree, hashed from its name; kept as zshrc's wt computed it, since a worktree's env files already hold the port (cli-stack's `stringToPort` now hashes differently).
export function stringToPort(s: string, min = 1024, max = 65535): number {
  let hash = 2166136261

  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = (hash * 16777619) >>> 0
  }

  return min + (hash % (max - min + 1))
}
