export const MIN_PORT = 1024
export const MAX_PORT = 65535
// Linux hands out ephemeral ports from 32768, so a service port stays below by default.
export const DEFAULT_MAX_PORT = 32767

// 32-bit FNV-1a over the UTF-16 code units of the name, folded into min..max.
export function stringToPort(name: string, min = MIN_PORT, max = DEFAULT_MAX_PORT): number {
  let hash = 2166136261

  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }

  return min + (hash % (max - min + 1))
}

// Binding the port on every interface fails with EADDRINUSE when anything on this machine holds it, whichever address it listens on.
export function isListening(port: number): boolean {
  try {
    Bun.listen({ hostname: '0.0.0.0', port, socket: { data: () => undefined } }).stop(true)

    return false
  }
  catch (error) {
    return (error as { code?: string }).code === 'EADDRINUSE'
  }
}
