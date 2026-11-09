import process from 'node:process'

// Stops this process and the rest of its job, as Ctrl+Z does outside raw mode; the kill returns once the shell resumes them (`fg`), or at once where nothing could resume them, as in a process group no shell controls.
export function stopJob(): void {
  process.kill(0, 'SIGTSTP')
}
