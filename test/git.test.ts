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
      "baseUrl": "git.kaynooo.fr",
      "baseUrlApi": "git.kaynooo.fr/api/v1",
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

    - **cli**: Rename \`groupByScope\` to \`group\` - by **Enzo Innocenzi** in [#22](https://git.kaynooo.fr/kaynooo/changelogitea/issues/22) [(89282)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/8928229)

    ### Features

    - Inline contributors - by **Anthony Fu** [(e4044)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/e404493)
    - Throw on shallow repo - by **Anthony Fu** [(f1c1f)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/f1c1fad)
    - Improve how references are displayed - by **Enzo Innocenzi** in [#19](https://git.kaynooo.fr/kaynooo/changelogitea/issues/19) [(cdf8f)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/cdf8fe5)
    - Support \`--no-emoji\` - by **Enzo Innocenzi** in [#20](https://git.kaynooo.fr/kaynooo/changelogitea/issues/20) [(e94ba)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/e94ba4a)
    - **contributors**:
     - Improve author list - by **Enzo Innocenzi** in [#18](https://git.kaynooo.fr/kaynooo/changelogitea/issues/18) [(8d8d9)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/8d8d914)
    - **style**:
     - Group scopes only when one of the scope have multiple commits - by **Anthony Fu** [(312f7)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/312f796)
     - Use \`<sup>\` for author info - by **Anthony Fu** [(b51c0)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/b51c075)
     - Limit sha to 5 letters and make monospace - by **Anthony Fu** [(b07ad)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/b07ade8)

    ### Bug Fixes

    - Use \`creatordate\` to sort tags - by **Frost Ming** in [#17](https://git.kaynooo.fr/kaynooo/changelogitea/issues/17) [(5666d)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/5666d8d)
    - Config defaults - by **Anthony Fu** [(9232f)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/9232fdf)
    - Use \`replace\` instead of \`replaceAll\` for Node 14 - by **Anthony Fu** [(5154e)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/5154e78)
    - **cli**: Add missing \`--group\` option - by **Enzo Innocenzi** in [#21](https://git.kaynooo.fr/kaynooo/changelogitea/issues/21) [(22800)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/228001d)
    - **style**: Revert \`<sup>\` style - by **Anthony Fu** [(742ae)](https://git.kaynooo.fr/kaynooo/changelogitea/commit/742ae0b)

    ### [View changes on Gitea](https://git.kaynooo.fr/kaynooo/changelogitea/compare/19cf4f84f16f1a8e1e7032bbef550c382938649d...49b0222e8d60b7f299941def7511cee0460a8149)"
  `)
})

it.each([
  { baseUrl: undefined, baseUrlApi: undefined, repo: undefined },
  { baseUrl: 'test.git.kaynooo.fr', baseUrlApi: 'api.test.git.kaynooo.fr', repo: 'user/changelogitea' },
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
      baseUrl: 'git.kaynooo.fr',
      baseUrlApi: 'git.kaynooo.fr/api/v1',
    }))
  }

  const urlsToGithub = md.match(regexToFindAllUrls)

  expect(urlsToGithub?.every(url => url.startsWith(`https://${config.baseUrl}`))).toBe(true)
})

it('should match with current gitea repo', async () => {
  const repo = await getGiteaRepo()

  expect(repo).toContain('/changelogitea')
})
