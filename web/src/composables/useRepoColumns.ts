import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import type { Repo } from '@shared/repo'

/**
 * 仓库列表的列定义。
 * 本项目只有「仓库列表」这一张表，故直接按 Repo 建模，不做泛型抽象（YAGNI）。
 * 宽度与对齐严格遵循 .codebuddy/规划/10-页面布局设计.md §3.3。
 */
export interface RepoColumnDef {
  /** 唯一键，同时是 localStorage 持久化的依据 */
  key: string
  label: string
  width?: number
  minWidth?: number
  align?: 'left' | 'center'
  headerAlign?: 'left' | 'center'
  fixed?: 'left' | 'right'
  /** true = 不可隐藏、不可拖拽（仓库名 / 操作） */
  locked?: boolean
  sortable?: boolean
  /** el-table 内置排序依据：普通字段用 prop，派生值用 sortBy */
  prop?: string
  sortBy?: (row: Repo) => string | number
  /** 溢出省略 + tooltip */
  ellipsis?: boolean
  defaultVisible: boolean
}

export const REPO_COLUMNS: RepoColumnDef[] = [
  {
    key: 'name',
    label: '仓库名',
    width: 180,
    fixed: 'left',
    locked: true,
    sortable: true,
    prop: 'name',
    ellipsis: true,
    defaultVisible: true,
  },
  {
    key: 'path',
    label: '路径',
    minWidth: 240,
    sortable: true,
    prop: 'path',
    ellipsis: true,
    defaultVisible: true,
  },
  {
    key: 'platform',
    label: '平台',
    width: 150,
    sortable: true,
    sortBy: (row) => row.platform?.label ?? '',
    defaultVisible: true,
  },
  {
    key: 'remote',
    label: 'Remote',
    minWidth: 200,
    ellipsis: true,
    defaultVisible: true,
  },
  {
    key: 'branch',
    label: '当前分支',
    width: 140,
    sortable: true,
    sortBy: (row) => row.status?.currentBranch ?? '',
    ellipsis: true,
    defaultVisible: true,
  },
  {
    key: 'status',
    label: '状态',
    minWidth: 220,
    defaultVisible: true,
  },
  {
    key: 'link',
    label: '未接入',
    width: 80,
    align: 'center',
    headerAlign: 'center',
    defaultVisible: true,
  },
  {
    key: 'lastCommit',
    label: '最后提交',
    width: 150,
    sortable: true,
    // lastCommitAt 为 ISO 字符串，字符串比较等价于时间比较
    sortBy: (row) => row.status?.lastCommitAt ?? '',
    defaultVisible: true,
  },
  {
    key: 'actions',
    label: '操作',
    width: 150,
    fixed: 'right',
    locked: true,
    align: 'center',
    headerAlign: 'center',
    defaultVisible: true,
  },
]

const STORAGE_KEY = 'gitventory:repo-columns:v1'

const DEF_BY_KEY = new Map(REPO_COLUMNS.map((col) => [col.key, col]))
/** 固定在首 / 尾的锁定列：不参与拖拽，顺序恒定 */
const HEAD_KEYS = REPO_COLUMNS.filter((col) => col.locked && col.fixed === 'left').map((col) => col.key)
const TAIL_KEYS = REPO_COLUMNS.filter((col) => col.locked && col.fixed === 'right').map((col) => col.key)

interface StoredConfig {
  order: string[]
  hidden: string[]
}

const EMPTY_CONFIG: StoredConfig = { order: [], hidden: [] }

/**
 * 读取持久化配置。任何异常（无 key / 非法 JSON / 字段类型不符 / 隐私模式禁用 storage）
 * 一律回退默认配置，绝不抛错。
 */
function loadStored(): StoredConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_CONFIG
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_CONFIG
    const record = parsed as Record<string, unknown>
    return {
      order: Array.isArray(record.order)
        ? record.order.filter((key): key is string => typeof key === 'string')
        : [],
      hidden: Array.isArray(record.hidden)
        ? record.hidden.filter((key): key is string => typeof key === 'string')
        : [],
    }
  } catch {
    return EMPTY_CONFIG
  }
}

/**
 * 合并「持久化顺序」与「代码定义」：
 * 未知 key 丢弃（版本演进）、新增列自动追加到尾部、锁定列强制首尾。
 */
function resolveOrder(stored: string[]): string[] {
  const known = REPO_COLUMNS.map((col) => col.key)
  const persisted = stored.filter((key) => DEF_BY_KEY.has(key))
  const middle = [
    ...persisted.filter((key) => !HEAD_KEYS.includes(key) && !TAIL_KEYS.includes(key)),
    ...known.filter(
      (key) => !persisted.includes(key) && !HEAD_KEYS.includes(key) && !TAIL_KEYS.includes(key),
    ),
  ]
  return [...HEAD_KEYS, ...middle, ...TAIL_KEYS]
}

/** 锁定列永不隐藏（即使持久化数据被手工改成隐藏） */
function resolveHidden(stored: string[]): Set<string> {
  return new Set(stored.filter((key) => DEF_BY_KEY.has(key) && !DEF_BY_KEY.get(key)?.locked))
}

/**
 * 模块级单例状态：列设置在「列表页工具区面板」与「表格渲染」两处共用同一份，
 * 因此不在函数内创建状态。
 */
const stored = loadStored()
const orderKeys = ref<string[]>(resolveOrder(stored.order))
const hiddenKeys = ref<Set<string>>(resolveHidden(stored.hidden))

function persist(): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ order: orderKeys.value, hidden: [...hiddenKeys.value] }),
    )
  } catch {
    // localStorage 不可用（隐私模式 / 配额满）时静默降级：本次会话内仍然生效
  }
}

/** 面板用：全部列（含已隐藏），按用户顺序 */
const ordered: ComputedRef<RepoColumnDef[]> = computed(() =>
  orderKeys.value.flatMap((key) => {
    const def = DEF_BY_KEY.get(key)
    return def ? [def] : []
  }),
)

/** 表格用：已排序且可见的列 */
const visible: ComputedRef<RepoColumnDef[]> = computed(() =>
  ordered.value.filter((col) => !hiddenKeys.value.has(col.key)),
)

function isVisible(key: string): boolean {
  return !hiddenKeys.value.has(key)
}

function toggle(key: string, value: boolean): void {
  if (DEF_BY_KEY.get(key)?.locked) return
  const next = new Set(hiddenKeys.value)
  if (value) next.delete(key)
  else next.add(key)
  hiddenKeys.value = next
  persist()
}

/** 拖拽：把 fromKey 移到 toKey 的位置；锁定列既不可拖动，也不可被挤走 */
function move(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return
  if (DEF_BY_KEY.get(fromKey)?.locked) return
  if (HEAD_KEYS.includes(toKey) || TAIL_KEYS.includes(toKey)) return
  const next = orderKeys.value.filter((key) => key !== fromKey)
  const target = next.indexOf(toKey)
  if (target < 0) return
  next.splice(target, 0, fromKey)
  orderKeys.value = next
  persist()
}

function reset(): void {
  orderKeys.value = resolveOrder([])
  hiddenKeys.value = new Set()
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略
  }
}

export function useRepoColumns(): {
  ordered: ComputedRef<RepoColumnDef[]>
  visible: ComputedRef<RepoColumnDef[]>
  isVisible: (key: string) => boolean
  toggle: (key: string, value: boolean) => void
  move: (fromKey: string, toKey: string) => void
  reset: () => void
} {
  return { ordered, visible, isVisible, toggle, move, reset }
}
