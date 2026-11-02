import { closeSync, constants, ftruncateSync, openSync, writeSync } from 'node:fs'
import process from 'node:process'
import { dlopen, FFIType } from 'bun:ffi'

const LOCK_EX = 2
const LOCK_NB = 4

type Flock = (fd: number, operation: number) => number

let flock: Flock | undefined

// The libc flock, which the kernel drops with the descriptor, so a holder killed by SIGKILL frees its lock.
function native(): Flock {
  flock ??= dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock

  return flock
}

export interface Held {
  fd: number
  release: () => void
}

// Takes the exclusive lock on a file, created when missing, without waiting; undefined while another descriptor holds it.
export function tryLock(path: string): Held | undefined {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600)

  if (native()(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd)

    return undefined
  }

  return { fd, release: () => closeSync(fd) }
}

// Replaces the file's content, which readers only trust while they find the lock held.
export function writeHeld(held: Held, text: string): void {
  ftruncateSync(held.fd)
  writeSync(held.fd, text, 0)
}
