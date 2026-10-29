import process from 'node:process'
import { runCommand } from '@kaynooo/cli-kit'
import { fold, shouldFold } from './fold'
import { saveLog } from './logs'

// Runs the command with stdout and stderr captured in arrival order, then replays short output untouched or prints it folded. Returns the command's exit code.
export async function run(command: string[], threshold: number): Promise<number> {
  let ran

  try {
    ran = await runCommand(command, { stdin: 'inherit' })
  }
  catch (error) {
    console.error(`out: cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`)

    return 127
  }

  const { code, chunks, output, text } = ran

  if (!shouldFold(text, threshold)) {
    for (const { stream, data } of chunks)
      process[stream].write(data)

    return code
  }

  process.stdout.write(fold(text, { threshold, logPath: await saveLog(output) }))

  return code
}
