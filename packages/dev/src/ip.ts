export const IP_SERVICE = 'https://ipecho.net/plain'

// The address the service sees this host as. curl is what picks the IP family, which fetch cannot.
export async function publicIp(family: 4 | 6 | undefined, service: string = IP_SERVICE): Promise<string> {
  const child = Bun.spawn(['curl', '--silent', '--show-error', '--fail', '--max-time', '10', ...family === undefined ? [] : [`-${family}`], service], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited])

  if (code !== 0)
    throw new Error(err.trim() === '' ? `curl exited ${code}` : err.trim())

  return out.trim()
}
