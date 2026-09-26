import axios from 'axios'
import type { OpenTargetInfo, Repo } from '@shared/repo'
import type {
  GitBatchData,
  GitBranchesData,
  GitCommitsData,
  GitOpData,
  GitStatusData,
} from '@shared/git'
import type { ApiResponse } from '@shared/api'

// 分支弹窗相关的类型直接复用服务端契约，避免两处声明漂移
export type { GitBatchData, GitBranchesData, GitCommit, GitCommitsData, GitOpData, GitStatusData } from '@shared/git'

export interface RepoSummary {
  total: number
  linked: number
  unlinked: number
  dirty: number
  stale: number
  aheadCurrentBranch: number
  unpushedAnyBranch: number
  byPlatform: Record<string, number>
  byUnlinkedReason: Record<string, number>
}

export interface RepoListData {
  scannedAt: string
  roots: string[]
  summary: RepoSummary
  items: Repo[]
  warnings: string[]
}

// GET /api/repos 查询参数（拼接为逗号分隔字符串）
export type RepoListSort = 'lastActivity' | 'name' | 'path'

export interface RepoListQuery {
  q?: string
  platform?: string[]
  link?: string[]
  status?: string[]
  sort?: RepoListSort
}

// GET /api/health
// 除 staleDays 外全部声明为可选：后端新增字段时前端不会崩，字段缺失时各消费方自行降级
export interface HealthData {
  staleDays: number
  /** 运行平台（darwin / win32 / linux…）：外部应用打开仅 macOS 可用 */
  platform?: string
  /** git 是否可用；不可用时 /api/repos 的 warnings 会给出原因 */
  git?: { available: boolean; version: string | null }
  /** 配置的扫描根（首屏兜底；实际扫描范围以扫描结果里的 roots 为准） */
  roots?: string[]
  maxDepth?: number
  // 各打开方式的本机可用性；声明为可选：旧后端不返回该字段，前端据此走降级（不禁用）
  openTargets?: OpenTargetInfo[]
}

// POST /api/repos/:localId/open
// 路径由后端解析，前端只传 localId 与 target（target 取值来自 /api/health.openTargets）
export interface OpenRepoData {
  opened: string
  path: string
}

const http = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

/** 请求超时（axios 层，服务端还没参与）单独给人话 */
const TIMEOUT_HINT = '请求超时，请重试'

/**
 * 从失败响应里取人话。
 *
 * 服务端所有失败都走统一出口，body 形如 `{ code, message }` 且 **message 是面向用户的中文**，
 * 但 axios 只在 2xx 时把 body 交给 onFulfilled —— 非 2xx（400/404/409/501…）必须在
 * 错误分支里自己去 `error.response.data` 捞，否则一律退化成
 * 「Request failed with status code 400」这种对用户毫无信息量的英文原话。
 * （这个坑真实发生过：分支名含中文被 400 拒绝时，用户只看到一句 status code 400。）
 */
function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body: unknown = error.response?.data
    if (body !== null && typeof body === 'object' && 'message' in body) {
      const message = (body as ApiResponse<unknown>).message
      if (typeof message === 'string' && message !== '') return message
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return TIMEOUT_HINT
    return error.message !== '' ? error.message : '网络错误'
  }
  return error instanceof Error && error.message !== '' ? error.message : '网络错误'
}

http.interceptors.response.use(
  (response) => {
    const body = response.data as ApiResponse<unknown>
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) {
        return Promise.reject(new Error(body.message || '请求失败'))
      }
      return body.data as never
    }
    return response
  },
  (error) => Promise.reject(new Error(apiErrorMessage(error))),
)

export async function getRepos(query: RepoListQuery = {}): Promise<RepoListData> {
  const params: Record<string, string> = {}
  if (query.q) params.q = query.q
  if (query.platform && query.platform.length > 0) params.platform = query.platform.join(',')
  if (query.link && query.link.length > 0) params.link = query.link.join(',')
  if (query.status && query.status.length > 0) params.status = query.status.join(',')
  if (query.sort) params.sort = query.sort
  return http.get('/repos', { params }) as Promise<RepoListData>
}

/** 全量扫描要走磁盘（首次可能数秒），与 git 网络操作同级放宽超时 */
const SCAN_TIMEOUT = 120_000

/**
 * POST /api/scan —— 按指定范围重新全量扫描。
 * - `roots` 非空：本次扫描用这些目录，且进程内后续扫描沿用；
 * - `roots` 传空数组：清除界面设置的覆盖，回到服务端配置的扫描根。
 *
 * 返回的是**未过滤**的全量结果，视图层需要筛选效果时应再取一次 /api/repos（缓存命中）。
 */
export async function scanRepos(roots?: string[]): Promise<RepoListData> {
  return http.post('/scan', roots === undefined ? {} : { roots }, {
    timeout: SCAN_TIMEOUT,
  }) as Promise<RepoListData>
}

export async function getHealth(): Promise<HealthData> {
  return http.get('/health') as Promise<HealthData>
}

export async function openRepo(localId: string, target: string): Promise<OpenRepoData> {
  return http.post(`/repos/${encodeURIComponent(localId)}/open`, { target }) as Promise<OpenRepoData>
}

// ---- Git 分支弹窗（/api/repos/:localId/*）----
// 路径一律由后端按 localId 反查，前端只传 localId 与分支名/文件名。

/** 与 origin 通信的操作（fetch/pull/push）单独放宽超时：服务端上限 120s */
const GIT_NETWORK_TIMEOUT = 130_000

function repoUrl(localId: string, suffix: string): string {
  return `/repos/${encodeURIComponent(localId)}${suffix}`
}

export async function getGitBranches(localId: string): Promise<GitBranchesData> {
  return http.get(repoUrl(localId, '/branches')) as Promise<GitBranchesData>
}

/** fetch --prune 后返回最新分支列表；fetch 失败会带 warning 降级返回 */
export async function fetchGitRemote(localId: string): Promise<GitBranchesData> {
  return http.post(repoUrl(localId, '/fetch'), {}, { timeout: GIT_NETWORK_TIMEOUT }) as Promise<GitBranchesData>
}

export async function getGitStatus(localId: string): Promise<GitStatusData> {
  return http.get(repoUrl(localId, '/status')) as Promise<GitStatusData>
}

export async function getGitCommits(
  localId: string,
  ref: string,
  skip: number,
  limit: number,
): Promise<GitCommitsData> {
  return http.get(repoUrl(localId, '/commits'), {
    params: { ref, skip, limit },
  }) as Promise<GitCommitsData>
}

export async function checkoutGitBranch(localId: string, branch: string): Promise<GitOpData> {
  return http.post(repoUrl(localId, '/checkout'), { branch }) as Promise<GitOpData>
}

export async function checkoutGitRemoteBranch(localId: string, remoteRef: string): Promise<GitOpData> {
  return http.post(repoUrl(localId, '/checkout-remote'), { remoteRef }) as Promise<GitOpData>
}

export async function pullGitBranch(localId: string): Promise<GitOpData> {
  return http.post(repoUrl(localId, '/pull'), {}, { timeout: GIT_NETWORK_TIMEOUT }) as Promise<GitOpData>
}

export async function pushGitBranch(localId: string): Promise<GitOpData> {
  return http.post(repoUrl(localId, '/push'), {}, { timeout: GIT_NETWORK_TIMEOUT }) as Promise<GitOpData>
}

export async function pushGitBranchToRemote(localId: string, branch: string): Promise<GitOpData> {
  return http.post(repoUrl(localId, '/push-remote'), { branch }, { timeout: GIT_NETWORK_TIMEOUT }) as Promise<GitOpData>
}

export async function restoreGitFiles(localId: string, files: string[]): Promise<GitOpData> {
  return http.post(repoUrl(localId, '/restore'), { files }) as Promise<GitOpData>
}

export async function deleteGitBranches(localId: string, branches: string[]): Promise<GitBatchData> {
  return http.post(repoUrl(localId, '/branches/delete'), { branches }) as Promise<GitBatchData>
}

export async function deleteGitRemoteBranches(
  localId: string,
  remoteRefs: string[],
): Promise<GitBatchData> {
  return http.post(repoUrl(localId, '/remote-branches/delete'), { remoteRefs }) as Promise<GitBatchData>
}
