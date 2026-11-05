// Runs `task` over `items` with at most `limit` in flight, answering in the order of `items`; a slow item holds up one slot, not a whole batch.
export async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++

      results[index] = await task(items[index] as T)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))

  return results
}
