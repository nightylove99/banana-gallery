import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type UpdateCheckStatus =
  | 'up-to-date'
  | 'update-available'
  | 'unconfigured'
  | 'no-release'
  | 'error'

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  currentVersion: string
  checkedAt: string
  repo?: string
  latestVersion?: string
  releaseName?: string
  releaseUrl?: string
  releasesUrl?: string
  publishedAt?: string
  releaseNotes?: string
  message: string
}

export function parseGitHubRepoSlug(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  const directMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed)
  if (directMatch) {
    const repo = directMatch[2].replace(/\.git$/i, '')
    return repo ? `${directMatch[1]}/${repo}` : null
  }

  const sshMatch = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(trimmed)
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`
  }

  try {
    const url = new URL(trimmed)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length < 2) return null
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/i, '')
    if (!owner || !repo) return null
    return `${owner}/${repo}`
  } catch {
    return null
  }
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  prerelease: string
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? '',
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) {
    const na = a.trim().replace(/^v/i, '')
    const nb = b.trim().replace(/^v/i, '')
    return na === nb ? 0 : na > nb ? 1 : -1
  }
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  if (pa.prerelease === pb.prerelease) return 0
  if (!pa.prerelease) return 1
  if (!pb.prerelease) return -1
  return pa.prerelease > pb.prerelease ? 1 : -1
}

function readPackageRepository(rootDir: string): string | null {
  try {
    const pkgPath = path.join(rootDir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      repository?: string | { url?: string }
    }
    if (typeof pkg.repository === 'string') return pkg.repository
    if (pkg.repository && typeof pkg.repository.url === 'string') return pkg.repository.url
    return null
  } catch {
    return null
  }
}

function readGitOriginUrl(rootDir: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return url || null
  } catch {
    return null
  }
}

export function resolveGitHubRepo(options?: {
  envRepo?: string
  rootDir?: string
  gitOriginUrl?: string | null
  packageRepoUrl?: string | null
}): string | null {
  const fromEnv = parseGitHubRepoSlug(options?.envRepo ?? process.env.BANANA_GALLERY_GITHUB_REPO)
  if (fromEnv) return fromEnv

  const rootDir = options?.rootDir ?? process.cwd()
  const pkgRaw = options?.packageRepoUrl !== undefined
    ? options.packageRepoUrl
    : readPackageRepository(rootDir)
  const fromPkg = parseGitHubRepoSlug(pkgRaw)
  if (fromPkg) return fromPkg

  const gitRaw = options?.gitOriginUrl !== undefined
    ? options.gitOriginUrl
    : readGitOriginUrl(rootDir)
  return parseGitHubRepoSlug(gitRaw)
}

function truncateNotes(body: unknown, maxChars = 600): string | undefined {
  if (typeof body !== 'string') return undefined
  const trimmed = body.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars).trimEnd()}…`
}

export async function checkForAppUpdate(options: {
  currentVersion: string
  repo?: string | null
  rootDir?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString()
  const currentVersion = options.currentVersion.trim().replace(/^v/i, '')
  const repo = options.repo !== undefined
    ? parseGitHubRepoSlug(options.repo)
    : resolveGitHubRepo({ rootDir: options.rootDir })

  if (!repo) {
    return {
      status: 'unconfigured',
      currentVersion,
      checkedAt,
      message: '尚未关联 GitHub 仓库地址。推送到 GitHub 或设置 BANANA_GALLERY_GITHUB_REPO 后即可在线检查更新。',
    }
  }

  const releasesUrl = `https://github.com/${repo}/releases`
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`
  const fetchFn = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 6000

  try {
    const response = await fetchFn(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `banana-gallery/${currentVersion}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (response.status === 404) {
      return {
        status: 'no-release',
        currentVersion,
        checkedAt,
        repo,
        releasesUrl,
        message: 'GitHub 仓库暂未发布正式 Release，可直接用 npm run update 拉取最新代码。',
      }
    }

    if (response.status === 403 || response.status === 429) {
      return {
        status: 'error',
        currentVersion,
        checkedAt,
        repo,
        releasesUrl,
        message: 'GitHub API 暂时限流，请稍后再试或直接前往仓库 Releases 页面查看。',
      }
    }

    if (!response.ok) {
      return {
        status: 'error',
        currentVersion,
        checkedAt,
        repo,
        releasesUrl,
        message: `检查更新失败（GitHub 返回 HTTP ${response.status}），可稍后重试。`,
      }
    }

    const payload = await response.json() as {
      tag_name?: string
      name?: string
      html_url?: string
      published_at?: string
      body?: string
    }
    const rawTag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : ''
    const latestVersion = rawTag.replace(/^v/i, '')
    if (!latestVersion) {
      return {
        status: 'error',
        currentVersion,
        checkedAt,
        repo,
        releasesUrl,
        message: 'GitHub Release 缺少版本号标签，请前往仓库页面确认。',
      }
    }

    const releaseUrl = typeof payload.html_url === 'string' && payload.html_url.trim()
      ? payload.html_url.trim()
      : `${releasesUrl}/tag/${encodeURIComponent(rawTag)}`
    const releaseName = typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : rawTag
    const publishedAt = typeof payload.published_at === 'string' ? payload.published_at : undefined
    const releaseNotes = truncateNotes(payload.body)

    if (compareSemver(latestVersion, currentVersion) > 0) {
      return {
        status: 'update-available',
        currentVersion,
        latestVersion,
        checkedAt,
        repo,
        releaseName,
        releaseUrl,
        releasesUrl,
        publishedAt,
        releaseNotes,
        message: `发现新版本 v${latestVersion}（当前 v${currentVersion}），运行 npm run update 即可升级。`,
      }
    }

    return {
      status: 'up-to-date',
      currentVersion,
      latestVersion,
      checkedAt,
      repo,
      releaseName,
      releaseUrl,
      releasesUrl,
      publishedAt,
      message: `当前已是最新版本（v${currentVersion}）。`,
    }
  } catch {
    return {
      status: 'error',
      currentVersion,
      checkedAt,
      repo,
      releasesUrl,
      message: '无法连接 GitHub（请检查网络或代理设置），也可以直接运行 npm run update。',
    }
  }
}
