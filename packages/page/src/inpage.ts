import type { Page } from 'playwright-core'

const EXPORT = /^export /gm
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' })
const sources = new Map<string, string>()

// The in-page code is a TypeScript project of its own, typed against the DOM, shipped beside dist and read from the same place by the source and the bundle.
async function source(file: 'measure' | 'compare'): Promise<string> {
  let code = sources.get(file)

  if (code === undefined) {
    code = transpiler.transformSync(await Bun.file(new URL(`../inpage/${file}.ts`, import.meta.url)).text()).replace(EXPORT, '')
    sources.set(file, code)
  }

  return code
}

/** Calls one export of an inpage/ file in the page, its argument sent as JSON. */
export async function inPage<T>(page: Page, file: 'measure' | 'compare', name: string, arg?: unknown): Promise<T> {
  return page.evaluate(`(() => {\n${await source(file)}\nreturn ${name}(${JSON.stringify(arg) ?? ''})\n})()`)
}

/** Has every document the page loads run one export of an inpage/ file first. */
export async function beforeLoad(page: Page, file: 'measure' | 'compare', name: string): Promise<void> {
  await page.addInitScript({ content: `(() => {\n${await source(file)}\n${name}()\n})()` })
}
