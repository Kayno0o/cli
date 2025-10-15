import { expect, it } from 'vitest'
import { generate, getGiteaRepo } from '../src'

const COMMIT_FROM = '19cf4f84f16f1a8e1e7032bbef550c382938649d'
const COMMIT_TO = '49b0222e8d60b7f299941def7511cee0460a8149'
const regexToFindAllUrls = /https:\/\/\S*/g

it('parse', async () => {
  const { config, md } = await generate({
    from: COMMIT_FROM,
    to: COMMIT_TO,
  })

  expect(config).toMatchInlineSnapshot(`
    {
      "baseUrl": "gitea.com",
      "baseUrlApi": "gitea.com/api/v1",
      "capitalize": true,
      "contributors": true,
      "from": "19cf4f84f16f1a8e1e7032bbef550c382938649d",
      "group": true,
      "prerelease": false,
      "releaseRepo": "kaynooo/changelogitea",
      "repo": "kaynooo/changelogitea",
      "scopeMap": {},
      "tag": "v%s",
      "tagFilter": [Function],
      "titles": {
        "breakingChanges": "🚨 Breaking Changes",
      },
      "to": "49b0222e8d60b7f299941def7511cee0460a8149",
      "types": {
        "build": {
          "title": "📦 Build",
        },
        "ci": {
          "title": "🤖 CI",
        },
        "docs": {
          "title": "📖 Documentation",
        },
        "feat": {
          "title": "🚀 Features",
        },
        "fix": {
          "title": "🐞 Bug Fixes",
        },
        "perf": {
          "title": "🏎 Performance",
        },
        "refactor": {
          "title": "💅 Refactors",
        },
        "style": {
          "title": "🎨 Styles",
        },
        "test": {
          "title": "✅ Tests",
        },
        "types": {
          "title": "🌊 Types",
        },
      },
    }
  `)
  expect(md.replace(/&nbsp;/g, ' ').replace(/ +/g, ' ')).toMatchInlineSnapshot(`
    "### Breaking Changes

    - **cli**: Rename \`groupByScope\` to \`group\` - by **Enzo Innocenzi** in https://gitea.com/kaynooo/changelogitea/issues/22 [<samp>(89282)</samp>](https://gitea.com/kaynooo/changelogitea/commit/8928229)

    ### Features

    - Inline contributors - by **Anthony Fu** [<samp>(e4044)</samp>](https://gitea.com/kaynooo/changelogitea/commit/e404493)
    - Throw on shallow repo - by **Anthony Fu** [<samp>(f1c1f)</samp>](https://gitea.com/kaynooo/changelogitea/commit/f1c1fad)
    - Improve how references are displayed - by **Enzo Innocenzi** in https://gitea.com/kaynooo/changelogitea/issues/19 [<samp>(cdf8f)</samp>](https://gitea.com/kaynooo/changelogitea/commit/cdf8fe5)
    - Support \`--no-emoji\` - by **Enzo Innocenzi** in https://gitea.com/kaynooo/changelogitea/issues/20 [<samp>(e94ba)</samp>](https://gitea.com/kaynooo/changelogitea/commit/e94ba4a)
    - **contributors**:
     - Improve author list - by **Enzo Innocenzi** in https://gitea.com/kaynooo/changelogitea/issues/18 [<samp>(8d8d9)</samp>](https://gitea.com/kaynooo/changelogitea/commit/8d8d914)
    - **style**:
     - Group scopes only when one of the scope have multiple commits - by **Anthony Fu** [<samp>(312f7)</samp>](https://gitea.com/kaynooo/changelogitea/commit/312f796)
     - Use \`<sup>\` for author info - by **Anthony Fu** [<samp>(b51c0)</samp>](https://gitea.com/kaynooo/changelogitea/commit/b51c075)
     - Limit sha to 5 letters and make monospace - by **Anthony Fu** [<samp>(b07ad)</samp>](https://gitea.com/kaynooo/changelogitea/commit/b07ade8)

    ### Bug Fixes

    - Use \`creatordate\` to sort tags - by **Frost Ming** in https://gitea.com/kaynooo/changelogitea/issues/17 [<samp>(5666d)</samp>](https://gitea.com/kaynooo/changelogitea/commit/5666d8d)
    - Config defaults - by **Anthony Fu** [<samp>(9232f)</samp>](https://gitea.com/kaynooo/changelogitea/commit/9232fdf)
    - Use \`replace\` instead of \`replaceAll\` for Node 14 - by **Anthony Fu** [<samp>(5154e)</samp>](https://gitea.com/kaynooo/changelogitea/commit/5154e78)
    - **cli**: Add missing \`--group\` option - by **Enzo Innocenzi** in https://gitea.com/kaynooo/changelogitea/issues/21 [<samp>(22800)</samp>](https://gitea.com/kaynooo/changelogitea/commit/228001d)
    - **style**: Revert \`<sup>\` style - by **Anthony Fu** [<samp>(742ae)</samp>](https://gitea.com/kaynooo/changelogitea/commit/742ae0b)

    ##### [View changes on Gitea](https://gitea.com/kaynooo/changelogitea/compare/19cf4f84f16f1a8e1e7032bbef550c382938649d...49b0222e8d60b7f299941def7511cee0460a8149)"
  `)
})

it.each([
  { baseUrl: undefined, baseUrlApi: undefined, repo: undefined },
  { baseUrl: 'test.gitea.com', baseUrlApi: 'api.test.gitea.com', repo: 'user/changelogitea' },
])('should generate config while baseUrl is set to $baseUrl', async (proposedConfig) => {
  const { config, md } = await generate({
    ...proposedConfig,
    from: COMMIT_FROM,
    to: COMMIT_TO,
  })

  if (proposedConfig.baseUrl) {
    expect(config).toEqual(expect.objectContaining(proposedConfig))
  }
  else {
    expect(config).toEqual(expect.objectContaining({
      baseUrl: 'gitea.com',
      baseUrlApi: 'gitea.com/api/v1',
    }))
  }

  const urlsToGithub = md.match(regexToFindAllUrls)

  expect(urlsToGithub?.every(url => url.startsWith(`https://${config.baseUrl}`))).toBe(true)
})

it('should match with current gitea repo', async () => {
  const repo = await getGiteaRepo()

  expect(repo).toContain('/changelogitea')
})
