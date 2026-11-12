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
