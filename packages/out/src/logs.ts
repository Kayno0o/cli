import { join } from 'node:path'
import process from 'node:process'
import { createLog, privateLogDirectory, sweepLogs } from '@kaynooo/cli-kit'

const MAX_AGE_MS = 24 * 60 * 60 * 1000

export async function logDir(): Promise<string> {
  return privateLogDirectory('out')
}

// Removes the logs older than a day, best effort since another run may be doing the same.
export async function cleanLogs(dir: string, now = Date.now()): Promise<void> {
  await sweepLogs(dir, MAX_AGE_MS, now)
}

// A new log in the folder, named after the time and the process so concurrent runs never share one; returns its path and descriptor.
export function newLog(dir: string): { path: string, fd: number } {
  const path = join(dir, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}.log`)

  return { path, fd: createLog(path) }
}
