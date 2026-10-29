export type Level = 'error' | 'warn'

export interface Finding {
  level: Level
  check: string
  message: string
}

export interface BuildSecret {
  id: string
  src?: string
  env?: string
}

export interface Release {
  slug: string
  sourceDir?: string
  buildContext?: string
  dockerfile?: string
  buildSecrets?: BuildSecret[]
  image?: string
  versionEnv?: string | null
  restartServices?: string[]
  postDeployCommands?: string[]
}

export interface Server {
  name: string
  composeArgs?: string[]
  releaseOverrides?: Record<string, { restartServices?: string[] }>
}

// The fields of release.config.ts the audit reads.
export interface ReleaseConfig {
  registry?: string
  releases?: Release[]
  servers?: Server[]
  requiredServerEnv?: string[]
  composeArgs?: string[]
  deploySyncFiles?: string[]
}

export interface ComposeVolume {
  source?: string
}

export interface ComposeService {
  image?: string
  healthcheck?: unknown
  ports?: unknown[]
  labels?: Record<string, unknown>
  volumes?: (string | ComposeVolume)[]
  environment?: Record<string, unknown>
}

// What `docker compose config --format json` prints.
export interface ComposeModel {
  services?: Record<string, ComposeService>
}

// Resolves the merged model of these compose files, and throws with the reason when it cannot.
export type ComposeLoader = (root: string, files: string[]) => Promise<ComposeModel>

export interface AuditOptions {
  root: string
  loadCompose: ComposeLoader
  env: Record<string, string | undefined>
  home: string
}

export interface AuditResult {
  root: string
  composeFiles: string[]
  findings: Finding[]
}

export interface EnvRef {
  name: string
  defaulted: boolean
  file: string
}
