import { expect, test } from 'bun:test'
import { runTool } from '../src/tool'

test('runTool decodes each stream apart, so a multibyte character split around the other stream survives', async () => {
  const script = 'printf "\\303"; sleep 0.2; printf "x" >&2; sleep 0.2; printf "\\251"; sleep 0.2; printf "\\303" >&2; sleep 0.2; printf "\\251" >&2'
  const ran = await runTool('split', ['sh', '-c', script])

  expect(ran).toEqual({ code: 0, stdout: 'é', stderr: 'xé' })
})
