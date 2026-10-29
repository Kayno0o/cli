# release one package with ft itself: `just release ft patch` bumps packages/ft, pushes main and its ft-v* tag atomically, then waits for CI and the registry
release package level:
    bun packages/ft/src/cli.ts release {{level}} --package {{package}}
