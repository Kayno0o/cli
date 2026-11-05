/** Folders a walk over a repository's packages never descends into: dependencies and build output. A bin adds its own to a copy. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', 'venv', '__pycache__'])
