import { capture } from '@kaynooo/cli-kit/test'
import { expect, test } from 'bun:test'
import { query, WRITE_EXIT } from '../src/commands/query'

test('a write handed back puts the reason on stderr and the statement alone on stdout', async () => {
  const { result, out, err } = await capture(async () => query(['--env', 'CLI_TEST_UNSET_DATABASE_URL', 'delete from users']))

  expect(result).toBe(WRITE_EXIT)
  expect(err).toStartWith('error: db: not run, this statement would write')
  expect(out).toBe('```sql\ndelete from users\n```\n')
})
