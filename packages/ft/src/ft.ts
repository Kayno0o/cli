#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runForge } from './cli'

process.exitCode = await runForge()
