#!/usr/bin/env node

import fs from 'node:fs/promises'
import process from 'node:process'
import { colors } from '@kaynooo/utils/tools'
import cac from 'cac'
import { execa } from 'execa'
import { version } from '../package.json'
import { uploadAssets } from './gitea'
import { generate, hasTagOnGitea, isRepoShallow, sendRelease } from './index'

const cli = cac('changelogitea')

cli
  .version(version)
  .option('-t, --token <path>', 'Gitea Token')
  .option('--from <ref>', 'From tag')
  .option('--to <ref>', 'To tag')
  .option('--gitea <path>', 'Gitea Repository, e.g. kaynooo/changelogitea')
  .option('--release-gitea <path>', 'Release Gitea Repository, defaults to `gitea`')
  .option('--name <name>', 'Name of the release')
  .option('--contributors', 'Show contributors section')
  .option('--prerelease', 'Mark release as prerelease')
  .option('-d, --draft', 'Mark release as draft')
  .option('--output <path>', 'Output to file instead of sending to Gitea')
  .option('--capitalize', 'Should capitalize for each comment message')
  .option('--emoji', 'Use emojis in section titles', { default: true })
  .option('--group', 'Nest commit messages under their scopes')
  .option('--dry', 'Dry run')
  .option('--assets <paths...>', 'Files to upload as assets to the release. Use quotes to prevent shell glob expansion, e.g., "--assets \'dist/*.js\'"')
  .help()

async function readTokenFromGiteaCli() {
  try {
    return (await execa('gh', ['auth', 'token'])).stdout.trim()
  }
  catch {
    return ''
  }
}

cli
  .command('')
  .action(async (args) => {
    const token = args.token || process.env.GITHUB_TOKEN || await readTokenFromGiteaCli()

    if (token) {
      args.token = token
    }

    let webUrl = ''

    try {
      console.log()
      console.log(colors.dim(`changelo${colors.bold('gitea')} `) + colors.dim(`v${version}`))

      const { config, md, commits } = await generate(args)

      webUrl = `https://${config.baseUrl}/${config.releaseRepo}/releases/new?title=${encodeURIComponent(String(config.name || config.to))}&body=${encodeURIComponent(String(md))}&tag=${encodeURIComponent(String(config.to))}&prerelease=${config.prerelease}`

      console.log(colors.cyan(config.from) + colors.dim(' -> ') + colors.blue(config.to) + colors.dim(` (${commits.length} commits)`))
      console.log(colors.dim('--------------'))
      console.log()
      console.log(md.replace(/&nbsp;/g, ''))
      console.log()
      console.log(colors.dim('--------------'))

      function printWebUrl() {
        console.log()
        console.error(colors.yellow('Using the following link to create it manually:'))
        console.error(colors.yellow(webUrl))
        console.log()
      }

      if (config.dry) {
        console.log(colors.yellow('Dry run. Release skipped.'))
        printWebUrl()

        return
      }

      if (typeof config.output === 'string') {
        await fs.writeFile(config.output, md, 'utf-8')
        console.log(colors.yellow(`Saved to ${config.output}`))

        return
      }

      if (!config.token) {
        console.error(colors.red('No Gitea token found, specify it via GITHUB_TOKEN env. Release skipped.'))
        process.exitCode = 1
        printWebUrl()

        return
      }

      if (!await hasTagOnGitea(config.to, config)) {
        console.error(colors.yellow(`Current ref "${colors.bold(config.to)}" is not available as tags on Gitea. Release skipped.`))
        process.exitCode = 1
        printWebUrl()

        return
      }

      if (!commits.length && await isRepoShallow()) {
        console.error(colors.yellow('The repo seems to be clone shallowly, which make changelog failed to generate. You might want to specify `fetch-depth: 0` in your CI config.'))
        process.exitCode = 1
        printWebUrl()

        return
      }

      await sendRelease(config, md)

      if (args.assets && args.assets.length > 0) {
        await uploadAssets(config, args.assets)
      }
    }
    catch (e: any) {
      console.error(colors.red(String(e)))

      if (e?.stack)
        console.error(colors.dim(e.stack?.split('\n').slice(1).join('\n')))

      if (webUrl) {
        console.log()
        console.error(colors.red('Failed to create the release. Using the following link to create it manually:'))
        console.error(colors.yellow(webUrl))
        console.log()
      }

      process.exit(1)
    }
  })

cli.parse()
