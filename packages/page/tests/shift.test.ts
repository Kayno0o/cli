import type { Finding } from '../src/report'
import type { LayoutBox } from '../src/types'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { layoutShifts } from '../src/layout'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()
const PLANS = '<section class="plans">Plans</section>'
const PAGE = (css: string, plans = PLANS): string => `<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:monospace}header{height:64px;background:#eee}h1{margin:0}main{padding:16px}section{margin:16px 0;height:100px}footer{height:40px}${css}</style><header class="top"><h1>Site</h1></header><main><section class="intro">Intro</section>${plans}<section class="faq">FAQ</section></main><footer>Footer</footer>`
const CARD = (tag: string, padding: number, body: string): string => `<!doctype html><meta charset="utf-8"><style>body{margin:16px;font-family:monospace}h2{margin:0 0 8px}.card{padding:${padding}px;border:1px solid}button{font:inherit}</style><h1>Pricing</h1><${tag} class="card"><h2>Pro</h2>${body}<button>Choose Pro</button></${tag}>`

async function shift(before: string, after: string): Promise<{ code: number, lines: string[] }> {
  const dir = temp('page-shift-')

  await Bun.write(join(dir, 'before.html'), before)
  await Bun.write(join(dir, 'after.html'), after)

  const child = Bun.spawn([process.execPath, CLI, 'shift', join(dir, 'before.html'), join(dir, 'after.html'), '-w', '800', '--json'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return { code, lines: (JSON.parse(out) as Finding[]).map(({ width, kind, selector, message }) => `${width} ${kind} ${selector}: ${message}`) }
}

describe('page shift', () => {
  test('a header grown 10px is one line naming the header, not everything below it', async () => {
    expect(await shift(PAGE(''), PAGE('header{height:74px}'))).toEqual({ code: 1, lines: ['800 resized header.top: 800×64 to 800×74px, pushing 5 elements'] })
  }, 60_000)

  test('a block removed, the blocks after it moving up with it', async () => {
    expect(await shift(PAGE(''), PAGE('', ''))).toEqual({ code: 1, lines: ['800 removed section.plans: 768×100px at 16,212, pushing 2 elements'] })
  }, 60_000)

  test('a margin changed moves its block alone', async () => {
    expect(await shift(PAGE(''), PAGE('.faq{margin-top:48px}'))).toEqual({ code: 1, lines: ['800 moved section.faq: down 32px, pushing 1 element'] })
  }, 60_000)

  test('the same page twice has nothing to report', async () => {
    expect(await shift(PAGE(''), PAGE(''))).toEqual({ code: 0, lines: [] })
  }, 60_000)

  test('a mockup against other markup pairs by text and names the padding and the wrapper added', async () => {
    expect(await shift(CARD('div', 16, '<p>All features</p>'), CARD('article', 24, '<div class="body"><p>All features</p></div>'))).toEqual({ code: 1, lines: ['800 resized article.card: 768×125 to 768×141px, padding 16 to 24px, pushing 2 elements', '800 added div.body: 718×17px at 41,130, pushing 1 element'] })
  }, 60_000)

  test('prints a line when nothing shifted', async () => {
    const dir = temp('page-shift-')

    await Bun.write(join(dir, 'page.html'), PAGE(''))

    const child = Bun.spawn([process.execPath, CLI, 'shift', join(dir, 'page.html'), join(dir, 'page.html'), '-w', '640'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

    expect(await new Response(child.stdout).text()).toBe('ok: nothing moved or resized at 640px\n')
  }, 60_000)
})

const BOX: LayoutBox = { parent: -1, id: '', selector: 'div', tag: 'div', label: '', x: 0, y: 0, width: 100, height: 100, padding: [0, 0, 0, 0], border: [0, 0, 0, 0] }

function box(fields: Partial<LayoutBox>): LayoutBox {
  return { ...BOX, ...fields }
}

describe('layoutShifts', () => {
  test('a centred box grown by its content moves by part of its growth, folded into that content', () => {
    const a = [box({ selector: 'body', width: 800, height: 600 }), box({ parent: 0, selector: 'div.dialog', x: 200, y: 250, width: 400, height: 100 }), box({ parent: 1, selector: 'h1', tag: 'h1', x: 200, y: 250, width: 400, height: 25 }), box({ parent: 1, selector: 'p', tag: 'p', x: 200, y: 275, width: 400, height: 75 })]
    const b = [a[0]!, box({ ...a[1]!, y: 238, height: 124 }), box({ ...a[2]!, y: 238, height: 49 }), box({ ...a[3]!, y: 287 })]

    expect(layoutShifts(a, b)).toEqual([{ kind: 'resized', selector: 'h1', message: '400×25 to 400×49px', pushed: 2 }])
  })

  test('a child whose width follows its parent\'s content box is not a cause', () => {
    const a = [box({ selector: 'body', width: 800, height: 600 }), box({ parent: 0, selector: 'aside', width: 300, height: 600 }), box({ parent: 1, selector: 'p', tag: 'p', width: 300, height: 40, label: 'Text' })]
    const b = [a[0]!, box({ ...a[1]!, width: 200, padding: [0, 10, 0, 10] }), box({ ...a[2]!, x: 10, width: 180, height: 60 })]

    expect(layoutShifts(a, b)).toEqual([{ kind: 'resized', selector: 'aside', message: '300×600 to 200×600px, padding 0 to 0 10 0 10px', pushed: 1 }])
  })

  test('a block left first by the removal of the one before it moved with that removal', () => {
    const a = [box({ selector: 'body', width: 800, height: 600 }), box({ parent: 0, selector: 'div.gone', label: 'Gone', height: 50 }), box({ parent: 0, selector: 'div.kept', label: 'Kept', y: 50, height: 50 })]
    const b = [a[0]!, box({ ...a[2]!, y: 0 })]

    expect(layoutShifts(a, b)).toEqual([{ kind: 'removed', selector: 'div.gone', message: '100×50px at 0,0', pushed: 1 }])
  })

  test('an item in a row pushed sideways by the item before it growing', () => {
    const a = [box({ selector: 'nav', width: 800, height: 40 }), box({ parent: 0, selector: 'a.home', tag: 'a', label: 'Home', height: 40 }), box({ parent: 0, selector: 'a.docs', tag: 'a', label: 'Docs', x: 100, height: 40 })]
    const b = [a[0]!, box({ ...a[1]!, width: 150 }), box({ ...a[2]!, x: 150 })]

    expect(layoutShifts(a, b)).toEqual([{ kind: 'resized', selector: 'a.home', message: '100×40 to 150×40px', pushed: 1 }])
  })

  test('an element added or removed with its children is one line each', () => {
    const a = [box({ selector: 'body', width: 800, height: 600 }), box({ parent: 0, selector: 'section.old', tag: 'section', label: 'Old', height: 50 }), box({ parent: 1, selector: 'em', tag: 'em', label: 'Old', width: 30, height: 20 })]
    const b = [a[0]!, box({ parent: 0, selector: 'aside.new', tag: 'aside', label: 'New', height: 50 }), box({ parent: 1, selector: 'span', tag: 'span', label: 'New', width: 30, height: 20 })]

    expect(layoutShifts(a, b)).toEqual([{ kind: 'removed', selector: 'section.old', message: '100×50px at 0,0', pushed: 0 }, { kind: 'added', selector: 'aside.new', message: '100×50px at 0,0', pushed: 0 }])
  })

  test('elements pair by id before their order, so two swapped ones are each a move', () => {
    const a = [box({ selector: 'body', width: 800, height: 600 }), box({ parent: 0, id: 'one', selector: 'div#one', height: 50 }), box({ parent: 0, id: 'two', selector: 'div#two', y: 50, height: 50 })]
    const b = [a[0]!, box({ ...a[2]!, y: 0 }), box({ ...a[1]!, y: 50 })]

    expect(layoutShifts(a, b)).toEqual([{ kind: 'moved', selector: 'div#one', message: 'down 50px', pushed: 0 }, { kind: 'moved', selector: 'div#two', message: 'up 50px', pushed: 0 }])
  })
})
