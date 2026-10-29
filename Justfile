# release a new version with ft itself: bump, atomic push of main and its tag, then wait for CI and the registry
patch:
    bun packages/ft/src/cli.ts release patch

minor:
    bun packages/ft/src/cli.ts release minor

major:
    bun packages/ft/src/cli.ts release major
