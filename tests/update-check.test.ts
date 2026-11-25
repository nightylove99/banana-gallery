import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkForAppUpdate,
  compareSemver,
  parseGitHubRepoSlug,
  resolveGitHubRepo,
} from '../server/personal/update-check.ts'

test('parseGitHubRepoSlug parses slug, https, and ssh URLs', () => {
  assert.equal(parseGitHubRepoSlug('clover/banana-gallery'), 'clover/banana-gallery')
  assert.equal(parseGitHubRepoSlug('https://github.com/clover/banana-gallery.git'), 'clover/banana-gallery')
  assert.equal(parseGitHubRepoSlug('https://github.com/clover/banana-gallery/'), 'clover/banana-gallery')
  assert.equal(parseGitHubRepoSlug('git@github.com:clover/banana-gallery.git'), 'clover/banana-gallery')
  assert.equal(parseGitHubRepoSlug('https://gitlab.com/clover/banana-gallery'), null)
  assert.equal(parseGitHubRepoSlug(''), null)
})

test('compareSemver compares versions cleanly', () => {
  assert.equal(compareSemver('0.72.0', '0.71.0'), 1)
  assert.equal(compareSemver('v0.72.0', '0.72.0'), 0)
  assert.equal(compareSemver('0.71.9', '0.72.0'), -1)
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1)
})

test('resolveGitHubRepo prefers env over package.json over git origin', () => {
  assert.equal(
    resolveGitHubRepo({
      envRepo: 'alice/from-env',
      packageRepoUrl: 'https://github.com/alice/from-pkg',
      gitOriginUrl: 'git@github.com:alice/from-git.git',
    }),
    'alice/from-env',
  )
  assert.equal(
    resolveGitHubRepo({
      envRepo: '',
      packageRepoUrl: 'https://github.com/alice/from-pkg.git',
      gitOriginUrl: 'git@github.com:alice/from-git.git',
    }),
    'alice/from-pkg',
  )
  assert.equal(
    resolveGitHubRepo({
      envRepo: '',
      packageRepoUrl: null,
      gitOriginUrl: 'git@github.com:alice/from-git.git',
    }),
    'alice/from-git',
  )
})

test('checkForAppUpdate returns unconfigured when no GitHub repo is set', async () => {
  const result = await checkForAppUpdate({ currentVersion: '0.72.0', repo: null })
  assert.equal(result.status, 'unconfigured')
  assert.equal(result.currentVersion, '0.72.0')
})

test('checkForAppUpdate detects available update and up-to-date states', async () => {
  const mockFetch = (async () => new Response(JSON.stringify({
    tag_name: 'v0.73.0',
    name: 'v0.73.0',
    html_url: 'https://github.com/clover/banana-gallery/releases/tag/v0.73.0',
    published_at: '2026-11-26T00:00:00Z',
    body: '新增一键更新与设置页检查更新按钮。',
  }), { status: 200 })) as typeof fetch

  const newer = await checkForAppUpdate({
    currentVersion: '0.72.0',
    repo: 'clover/banana-gallery',
    fetchImpl: mockFetch,
  })
  assert.equal(newer.status, 'update-available')
  assert.equal(newer.latestVersion, '0.73.0')
  assert.equal(newer.releaseUrl, 'https://github.com/clover/banana-gallery/releases/tag/v0.73.0')

  const same = await checkForAppUpdate({
    currentVersion: '0.73.0',
    repo: 'clover/banana-gallery',
    fetchImpl: mockFetch,
  })
  assert.equal(same.status, 'up-to-date')
})

test('checkForAppUpdate degrades gracefully on 404 and network errors', async () => {
  const notFound = await checkForAppUpdate({
    currentVersion: '0.72.0',
    repo: 'clover/banana-gallery',
    fetchImpl: (async () => new Response('Not Found', { status: 404 })) as typeof fetch,
  })
  assert.equal(notFound.status, 'no-release')

  const offline = await checkForAppUpdate({
    currentVersion: '0.72.0',
    repo: 'clover/banana-gallery',
    fetchImpl: (async () => { throw new Error('network down') }) as typeof fetch,
  })
  assert.equal(offline.status, 'error')
})
