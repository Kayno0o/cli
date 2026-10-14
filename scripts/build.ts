const result = await Bun.build({
  entrypoints: ['src/index.ts', 'src/cli.ts'],
  outdir: 'dist',
  root: 'src',
  target: 'bun',
  format: 'esm',
  splitting: true,
  external: ['bun'],
})

if (!result.success) {
  for (const log of result.logs)
    console.error(log)
  process.exit(1)
}
