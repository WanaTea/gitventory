import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { OpenTargetInfo, Repo } from '@shared/repo'
import { getHealth, getRepos, scanRepos } from '../api'
import type { RepoListQuery, RepoListSort, RepoSummary } from '../api'

// 清单页筛选条件（与 GET /api/repos 查询参数一一对应）
export interface RepoFilters {
  q: string
  platform: string[]
  link: string[]
  status: string[]
  sort: RepoListSort
}

function createDefaultFilters(): RepoFilters {
  return {
    q: '',
    platform: [],
    link: [],
    status: [],
    sort: 'lastActivity',
  }
}

// health 拉取失败时的兜底阈值（仅用于图例文案）
// 与后端 config.staleDays 默认值保持一致（server/src/config/index.ts: 90），
// 仅在 /api/health 不可用时作为兜底，避免图例文案与实际判定口径不一致
const DEFAULT_STALE_DAYS = 90
// 同上：扫描深度兜底，仅用于空态文案
const DEFAULT_MAX_DEPTH = 5

export const useRepoStore = defineStore('repo', () => {
  const repos = ref<Repo[]>([])
  const summary = ref<RepoSummary | null>(null)
  const scannedAt = ref<string>('')
  const warnings = ref<string[]>([])
  const loading = ref(false)
  // 「按指定范围重扫」进行中：与 loading（拉列表）分开，空态按钮各自显示自己的进度
  const scanning = ref(false)
  const error = ref('')
  const staleDays = ref<number>(DEFAULT_STALE_DAYS)
  // 打开方式可用性（GET /api/health.openTargets）；空数组 = 未取到 → 消费方降级为「不禁用」
  const openTargets = ref<OpenTargetInfo[]>([])

  // ── 运行环境与扫描范围（GET /api/health）──────────────
  // 只在「未取到」时为 null：首屏据此区分「还没问」与「问了，确实没有 git」
  const gitAvailable = ref<boolean | null>(null)
  const platform = ref('')
  const maxDepth = ref(DEFAULT_MAX_DEPTH)
  // 实际扫描范围：以最近一次扫描结果为准（health 的 roots 只作首屏兜底）
  const roots = ref<string[]>([])

  const filters = ref<RepoFilters>(createDefaultFilters())

  const gitMissing = computed(() => gitAvailable.value === false)

  // 请求序号：仅应用最新一次请求的结果，丢弃过期响应
  let reqSeq = 0

  function buildQuery(): RepoListQuery {
    const f = filters.value
    return {
      q: f.q.trim() || undefined,
      platform: f.platform,
      link: f.link,
      status: f.status,
      sort: f.sort,
    }
  }

  async function fetchRepos(): Promise<boolean> {
    const seq = ++reqSeq
    loading.value = true
    error.value = ''
    try {
      const data = await getRepos(buildQuery())
      if (seq !== reqSeq) return true // 已被更新请求取代，丢弃本次结果
      repos.value = data.items
      summary.value = data.summary
      scannedAt.value = data.scannedAt
      warnings.value = data.warnings
      if (Array.isArray(data.roots) && data.roots.length > 0) roots.value = data.roots
      return true
    } catch (e) {
      if (seq !== reqSeq) return true
      error.value = e instanceof Error ? e.message : '加载仓库列表失败'
      return false
    } finally {
      if (seq === reqSeq) loading.value = false
    }
  }

  async function fetchHealth(): Promise<void> {
    try {
      const data = await getHealth()
      if (typeof data.staleDays === 'number' && data.staleDays > 0) {
        staleDays.value = data.staleDays
      }
      if (typeof data.platform === 'string') platform.value = data.platform
      if (typeof data.git?.available === 'boolean') gitAvailable.value = data.git.available
      if (typeof data.maxDepth === 'number' && data.maxDepth > 0) maxDepth.value = data.maxDepth
      // 仅首屏兜底：真正扫了什么以扫描结果里的 roots 为准
      if (Array.isArray(data.roots) && roots.value.length === 0) roots.value = data.roots
      // 旧后端可能不返回 openTargets：保持空数组，由消费方按「未知即可用」降级
      if (Array.isArray(data.openTargets)) {
        openTargets.value = data.openTargets
      }
    } catch {
      // health 为辅助信息，失败时保留兜底阈值与空可用性列表，不打断主流程
    }
  }

  /**
   * 按指定范围重新全量扫描。
   *
   * `rootsOverride` 传空数组 = 清除界面设置的覆盖、回到服务端配置的扫描根。
   * 扫描接口返回的是**未过滤**的全量结果，故扫完后再走一次 fetchRepos 套用当前筛选条件
   * （第二次是缓存命中，代价很小；否则筛选条件会在重扫后被悄悄丢掉）。
   */
  async function scanWithRoots(rootsOverride: string[]): Promise<boolean> {
    scanning.value = true
    error.value = ''
    try {
      await scanRepos(rootsOverride)
      return await fetchRepos()
    } catch (e) {
      error.value = e instanceof Error && e.message !== '' ? e.message : '重新扫描失败'
      return false
    } finally {
      scanning.value = false
    }
  }

  function resetFilters(): void {
    filters.value = createDefaultFilters()
  }

  return {
    repos,
    summary,
    scannedAt,
    warnings,
    loading,
    scanning,
    error,
    staleDays,
    openTargets,
    gitAvailable,
    gitMissing,
    platform,
    maxDepth,
    roots,
    filters,
    fetchRepos,
    fetchHealth,
    scanWithRoots,
    resetFilters,
  }
})

// 供视图复用的「是否处于某一筛选」判断
export function isFilterEmpty(f: RepoFilters): boolean {
  return (
    f.q.trim() === '' &&
    f.platform.length === 0 &&
    f.link.length === 0 &&
    f.status.length === 0
  )
}

export function singleEquals(values: string[], value: string): boolean {
  return values.length === 1 && values[0] === value
}
