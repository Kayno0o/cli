import { describe, expect, it } from 'bun:test'
import { notification, notifyEnd } from '../src/notify'

const TITLE = Buffer.from('ft release').toString('base64')
const BODY = Buffer.from('done in 12.0s').toString('base64')

// A terminal on stderr that keeps what is written to it.
function screen(): { stream: { isTTY: boolean, write: (text: string) => void }, written: string[] } {
  const written: string[] = []

  return { stream: { isTTY: true, write: text => void written.push(text) }, written }
}

describe('notification', () => {
  it('sends the title then the body in kitty\'s codes, shown only while the window is out of focus', () => {
    const codes = notification('ft release', 'done in 12.0s', {})

    expect(codes).toMatch(new RegExp(`^\\x1B\\]99;i=(kit\\d+):d=0:o=unfocused:e=1;${TITLE}\\x1B\\\\\\x1B\\]99;i=\\1:p=body:e=1;${BODY}\\x1B\\\\$`))
  })

  it('wraps each code in tmux\'s passthrough, its escapes doubled', () => {
    const codes = notification('ft release', 'done in 12.0s', { TMUX: '/tmp/tmux-1000/default,1,0' })

    expect(codes.startsWith(`\x1BPtmux;\x1B\x1B]99;i=`)).toBe(true)
    expect(codes).toContain(`${TITLE}\x1B\x1B\\\x1B\\\x1BPtmux;\x1B\x1B]99;`)
    expect(codes.endsWith(`${BODY}\x1B\x1B\\\x1B\\`)).toBe(true)
  })
})

describe('notifyEnd', () => {
  it('tells a terminal a command of ten seconds or more is done or failed', () => {
    const { stream, written } = screen()

    notifyEnd('ft release', 0, 12_000, { stream, env: {} })
    notifyEnd('check', 1, 75_000, { stream, env: {} })

    expect(written).toEqual([notification('ft release', 'done in 12.0s', {}), notification('check', 'failed with exit 1 after 1m 15s', {})])
  })

  it('says nothing of a short command, a cancelled one, or off a person\'s terminal', () => {
    const { stream, written } = screen()

    notifyEnd('check', 0, 9_999, { stream, env: {} })
    notifyEnd('check', 130, 60_000, { stream, env: {} })
    notifyEnd('check', 0, 60_000, { stream, env: { CLAUDECODE: '1' } })
    notifyEnd('check', 0, 60_000, { stream: { ...stream, isTTY: false }, env: { CI: 'true' } })

    expect(written).toEqual([])
  })
})
