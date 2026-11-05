#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { audit } from './audit'

process.exitCode = await runMain({ name: 'audit', run: audit })
