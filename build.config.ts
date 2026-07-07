import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: [
    'src/index',
    'src/cli',
  ],
  declaration: true,
  clean: true,
  externals: ['bun'],
  rollup: {
    emitCJS: false,
    inlineDependencies: [
      '@kaynooo/utils',
    ],
  },
})
