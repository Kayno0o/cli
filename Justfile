# release a new version with ft itself: bump, atomic push of main and its tag, then wait for CI and the registry
patch:
    bun src/cli.ts release patch

minor:
    bun src/cli.ts release minor

major:
    bun src/cli.ts release major
