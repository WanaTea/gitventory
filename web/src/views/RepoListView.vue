<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { QuestionFilled, Rank, Refresh, Search, Setting } from '@element-plus/icons-vue'
import { PLATFORM_LABELS, PLATFORM_TYPES } from '@shared/platform'
import type { Repo } from '@shared/repo'
import { isFilterEmpty, singleEquals, useRepoStore } from '../stores/repo'
import RepoTable from '../components/RepoTable.vue'
import GitModal from '../components/GitModal.vue'
import { useRepoColumns } from '../composables/useRepoColumns'
import { formatDateTime, relativeTime } from '../utils/format'
import { isAbsoluteInput } from '../utils/path'

const store = useRepoStore()

// ── Git 分支弹窗 ──────────────────────────────
// 用 v-if 挂载：每次打开都是新实例，弹窗内部状态无需手写复位
const gitTarget = ref<Repo | null>(null)

function openGit(repo: Repo): void {
  gitTarget.value = repo
}

/** 弹窗里做过写操作（切换/拉取/推送/删除/撤销）→ 清单状态已变，重新拉取（失败弹提示） */
function onGitChanged(): void {
  void query()
}

// ── 扫描范围 ──────────────────────────────
// 初装用户的两个困惑（「扫了哪里」与「怎么改」）都落在这一小块上：
// 范围必须常驻可见（工具区的 scope chip），并且能就地修改（弹窗 + 立即重扫）。
const scanDialogVisible = ref(false)
const rootInput = ref('')

/** 常见仓库位置：点一下填进输入框，省去手打路径 */
const SUGGESTED_ROOTS = ['~/code', '~/Projects', '~/dev', '~/Documents', '~/Desktop']

/**
 * 「让 AI 代劳」的提示词：给用户一段可以直接交给 AI 的指令。
 *
 * 为什么需要它：常见开发目录只覆盖一部分人，真正的工作目录散在 IDE 与终端的
 * 「最近打开」记录里（VS Code 的 globalStorage、JetBrains 的 recentProjects、
 * shell 历史里的 cd）—— 让用户自己回忆这些位置不现实。macOS 与 Windows 的
 * 记录路径完全不同，所以两套都写进提示词，让 AI 先判断系统。
 *
 * 用 String.raw：内容里全是 Windows 反斜杠路径，普通字符串字面量会把 `\d` 这类
 * 序列吃掉一个反斜杠，写出来的路径直接是错的。
 */
const AI_PROMPT = String.raw`我在用 Gitventory（本机 git 仓库盘点工具），需要填「扫描范围」。请帮我找出本机该扫描哪些目录。

1. 先判断我用的系统（macOS 还是 Windows）。
2. 检查这些常见开发目录（存在才用）：
   macOS：~/code、~/Code、~/Projects、~/dev、~/Developer、~/workspace、~/repos、~/src、~/Documents、~/Desktop
   Windows：%USERPROFILE%\code、%USERPROFILE%\Projects、%USERPROFILE%\develop、%USERPROFILE%\dev、%USERPROFILE%\workspace、D:\code、D:\develop、D:\Projects
3. 再读编辑器 / 终端的「最近打开」记录，从中提取项目目录 —— 这步最关键，常见目录往往覆盖不到真实工作目录：
   - VS Code：macOS ~/Library/Application Support/Code/User/globalStorage/storage.json
               Windows %APPDATA%\Code\User\globalStorage\storage.json
     （Insiders 把 Code 换成 "Code - Insiders"，Cursor 换成 Cursor）
   - JetBrains：macOS ~/Library/Application Support/JetBrains/*/options/recentProjects.xml
                Windows %APPDATA%\JetBrains\*\options\recentProjects.xml
   - Windows Terminal：%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_*\LocalState\settings.json
   - Shell 历史：~/.zsh_history、~/.bash_history（里面 cd 过的目录）；
     PowerShell：%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt
4. 合并去重后按这几条收敛：
   - 只保留真实存在的目录
   - 父目录已覆盖子目录的（如 D:\develop 覆盖 D:\develop\ai），只留父目录
   - 不要把整个盘符或整个家目录塞进来，会让扫描很慢
   - 最多 10 个，按重要性排序
5. 输出一份「每行一个目录」的清单，我可以直接粘贴；每个目录注明来源（常见目录 / VS Code 最近打开 / JetBrains 最近项目 / shell 历史）。`

async function copyAiPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(AI_PROMPT)
    ElMessage.success('已复制，粘贴给你的 AI 即可')
  } catch {
    // 剪贴板 API 在非安全上下文（非 localhost 的 http）会被拒
    ElMessage.error('复制失败，请手动选中文本复制')
  }
}

const scopeSummary = computed(() => {
  const list = store.roots
  if (list.length === 0) return '未设置'
  if (list.length === 1) return list[0] ?? ''
  return `${list[0]} 等 ${list.length} 处`
})

function openScanDialog(): void {
  rootInput.value = store.roots.join('\n')
  scanDialogVisible.value = true
}

function addRoot(path: string): void {
  const lines = rootInput.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.includes(path)) return
  rootInput.value = [...lines, path].join('\n')
}

/**
 * 解析输入框：每行一个路径，允许 `~`。
 * 相对路径直接拒绝 —— 它会被按「服务进程的工作目录」解析，结果取决于服务怎么启动，
 * 这种不确定性不该让用户到结果里去猜。返回 null 表示存在非法输入。
 *
 * 绝对路径的判定交给 utils/path.ts（跨平台：POSIX、Windows 盘符、UNC、`~`）——
 * 原先只认 `/` 与 `~`，Windows 上填盘符路径会被误判成相对路径。
 */
function parseRootLines(text: string): string[] | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const invalid = lines.find((line) => !isAbsoluteInput(line))
  return invalid === undefined ? lines : null
}

/**
 * 唤起系统自带的文件夹选择框（macOS 的 Finder 面板 / Windows 的资源管理器），
 * 把选中的目录追加进输入框。
 *
 * 为什么不用浏览器自己的目录选择：它只给目录句柄、**不给绝对路径**，
 * 没有路径就没法交给服务端扫描 —— 所以这个框必须由本地服务进程来弹。
 */
async function browseDir(): Promise<void> {
  const path = await store.pickDir()
  if (path !== null) {
    addRoot(path)
    return
  }
  // null + error 非空 = 真的失败了；null + error 为空 = 用户点了取消，不该弹提示
  if (store.error !== '') ElMessage.error(store.error)
}

/** reset = true 表示清除界面设置的覆盖，回到服务端配置的扫描根 */
async function applyScan(reset: boolean): Promise<void> {
  const roots = reset ? [] : parseRootLines(rootInput.value)
  if (roots === null) {
    ElMessage.warning('请填写绝对路径（如 /Users/code、D:\\code，或以 ~ 开头），每行一个')
    return
  }
  const ok = await store.scanWithRoots(roots)
  if (!ok) {
    ElMessage.error(store.error || '重新扫描失败')
    return
  }
  ElMessage.success(`已扫描 ${store.summary?.total ?? 0} 个仓库`)
  scanDialogVisible.value = false
}

// ── 概览卡：点击即筛选 ──────────────────────────────
type CardDim = 'link' | 'status'

interface OverviewCard {
  key: string
  label: string
  value: number
  dim: CardDim | null
  filterValue: string | null
}

// 概览指标：按「可行动性」排序（最需要处理的靠前）
const cards = computed<OverviewCard[]>(() => {
  const s = store.summary
  if (!s) return []
  return [
    { key: 'total', label: '仓库总数', value: s.total, dim: null, filterValue: null },
    { key: 'unlinked', label: '未接入', value: s.unlinked, dim: 'link', filterValue: 'unlinked' },
    { key: 'dirty', label: '脏仓库', value: s.dirty, dim: 'status', filterValue: 'dirty' },
    { key: 'linked', label: '已接入', value: s.linked, dim: 'link', filterValue: 'linked' },
    {
      key: 'ahead',
      label: '未推送（当前分支）',
      value: s.aheadCurrentBranch,
      dim: 'status',
      filterValue: 'ahead',
    },
  ]
})

function isCardActive(card: OverviewCard): boolean {
  const f = store.filters
  if (card.key === 'total') return isFilterEmpty(f)
  if (card.dim === 'link' && card.filterValue) return singleEquals(f.link, card.filterValue)
  if (card.dim === 'status' && card.filterValue) return singleEquals(f.status, card.filterValue)
  return false
}

function toggleCard(card: OverviewCard): void {
  const f = store.filters
  if (card.key === 'total') {
    store.resetFilters()
    return
  }
  if (!card.dim || !card.filterValue) return
  const active = singleEquals(f[card.dim], card.filterValue)
  f[card.dim] = active ? [] : [card.filterValue]
}

// ── 筛选器选项 ──────────────────────────────
const platformOptions = PLATFORM_TYPES.map((t) => ({
  value: t as string,
  label: PLATFORM_LABELS[t],
}))

const linkOptions: { value: string; label: string }[] = [
  { value: 'linked', label: '已接入' },
  { value: 'unlinked', label: '未接入' },
  { value: 'N1', label: 'N1' },
  { value: 'N2', label: 'N2' },
]

const statusOptions: { value: string; label: string }[] = [
  { value: 'dirty', label: '脏' },
  { value: 'ahead', label: '未推送' },
  { value: 'stale', label: '久未动' },
]

// ── 列设置（显示/隐藏 + 拖拽排序，自动持久化）──────────
// 排序统一由列头承担（el-table 内置排序），故不再提供「排序」下拉——同一目的不应有两套入口。
// store.filters.sort 仍保留为服务端默认排序（保证初始顺序稳定），只是不再有 UI 入口。
const {
  ordered: allColumns,
  isVisible: isColumnVisible,
  toggle: toggleColumn,
  move: moveColumn,
  reset: resetColumns,
} = useRepoColumns()

// 拖拽中的列 key，仅用于视觉反馈
const draggingKey = ref('')

function onColumnDragStart(key: string): void {
  draggingKey.value = key
}

function onColumnDrop(toKey: string): void {
  if (draggingKey.value) moveColumn(draggingKey.value, toKey)
  draggingKey.value = ''
}

// 「仅看非干净」：与状态筛选共享同一字段——勾选=固定为「脏 + 未推送」，手动改状态会自动取消勾选
function isNonClean(): boolean {
  const s = store.filters.status
  return s.length === 2 && s.includes('dirty') && s.includes('ahead')
}

const nonCleanOnly = computed<boolean>({
  get: isNonClean,
  set: (value: boolean) => {
    store.filters.status = value ? ['dirty', 'ahead'] : []
  },
})

// ── 查询（防抖 300ms，自动触发）──────────────────
let debounceTimer: number | undefined

async function query(showToast = false): Promise<void> {
  const ok = await store.fetchRepos()
  if (!ok) {
    ElMessage.error(store.error || '加载仓库列表失败')
  } else if (showToast) {
    ElMessage.success(`已加载 ${store.repos.length} 个仓库`)
  }
}

function scheduleQuery(): void {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    void query()
  }, 300)
}

function reload(): void {
  void query(true)
}

watch(() => store.filters, scheduleQuery, { deep: true })

onMounted(() => {
  void store.fetchHealth()
  void query(true)
})

onBeforeUnmount(() => {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
})
</script>

<template>
  <div class="repo-list-view">
    <!-- ⓪ 环境告警：没有 git 时整页数据都不可信（全会被判成「未接入、无改动」），必须置顶说清 -->
    <section
      v-if="store.gitMissing"
      class="banner"
    >
      <span class="banner-title">未检测到 git 命令</span>
      <span class="banner-text">
        平台、改动状态与分支信息都无法采集，列表里的「未接入 / 无改动」并不代表真实情况。
        安装 git 并确保它在 PATH 中，然后重启本服务即可自动恢复。
      </span>
    </section>

    <!-- ① 概览区：5 列等分栅格，点击即筛选 -->
    <section class="metrics">
      <button
        v-for="card in cards"
        :key="card.key"
        type="button"
        class="metric"
        :class="{ 'is-active': isCardActive(card) }"
        @click="toggleCard(card)"
      >
        <span class="metric-label">{{ card.label }}</span>
        <span class="metric-value tnum">{{ card.value }}</span>
        <span
          v-if="isCardActive(card)"
          class="metric-hint"
        >
          显示中 {{ store.repos.length }}
        </span>
      </button>
    </section>

    <!-- ② 工具区：左侧筛选成组，右侧「时间戳 + 操作」成组 -->
    <section class="toolbar">
      <div class="toolbar-filters">
        <el-input
          v-model="store.filters.q"
          :prefix-icon="Search"
          placeholder="搜索仓库名或路径"
          clearable
          class="filter-search"
        />
        <el-select
          v-model="store.filters.platform"
          multiple
          clearable
          collapse-tags
          placeholder="平台"
          class="filter-select"
        >
          <el-option
            v-for="opt in platformOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-select
          v-model="store.filters.link"
          multiple
          clearable
          collapse-tags
          placeholder="连接状态"
          class="filter-select"
        >
          <el-option
            v-for="opt in linkOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-select
          v-model="store.filters.status"
          multiple
          clearable
          collapse-tags
          placeholder="状态"
          class="filter-select"
        >
          <el-option
            v-for="opt in statusOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-checkbox v-model="nonCleanOnly">
          仅看非干净
        </el-checkbox>
      </div>

      <div class="toolbar-actions">
        <!-- 扫描范围常驻可见：用户第一次打开就知道「它在扫哪里」 -->
        <el-tooltip placement="bottom-end">
          <template #content>
            <div>当前扫描范围</div>
            <div
              v-for="root in store.roots"
              :key="root"
            >
              {{ root }}
            </div>
          </template>
          <button
            type="button"
            class="scope-chip"
            @click="openScanDialog"
          >
            <span class="scope-chip-label">扫描范围</span>
            <span class="scope-chip-value">{{ scopeSummary }}</span>
          </button>
        </el-tooltip>
        <span
          v-if="store.scannedAt"
          class="scanned-at tnum"
        >
          扫描于 {{ formatDateTime(store.scannedAt) }}（{{ relativeTime(store.scannedAt) }}）
        </span>
        <el-button
          type="primary"
          :icon="Refresh"
          :loading="store.loading"
          :disabled="store.loading"
          @click="reload"
        >
          重新加载
        </el-button>
        <el-popover
          placement="bottom-end"
          trigger="click"
          :width="220"
        >
          <template #reference>
            <el-button :icon="Setting">
              列设置
            </el-button>
          </template>
          <div class="column-settings">
            <span class="column-settings-tip">拖拽调整顺序，勾选控制显示</span>
            <div class="column-list">
              <div
                v-for="col in allColumns"
                :key="col.key"
                class="column-item"
                :class="{
                  'is-dragging': draggingKey === col.key,
                  'is-locked': col.locked,
                }"
                :draggable="!col.locked"
                @dragstart="onColumnDragStart(col.key)"
                @dragover.prevent
                @drop="onColumnDrop(col.key)"
                @dragend="draggingKey = ''"
              >
                <el-icon
                  v-if="!col.locked"
                  class="drag-handle"
                >
                  <Rank />
                </el-icon>
                <span
                  v-else
                  class="drag-handle is-placeholder"
                />
                <el-checkbox
                  :model-value="isColumnVisible(col.key)"
                  :disabled="col.locked"
                  @update:model-value="(value: boolean | string | number) => toggleColumn(col.key, !!value)"
                >
                  {{ col.label }}
                </el-checkbox>
              </div>
            </div>
            <el-divider class="column-divider" />
            <el-button
              link
              type="primary"
              size="small"
              @click="resetColumns()"
            >
              重置为默认
            </el-button>
          </div>
        </el-popover>
        <el-popover
          placement="bottom-end"
          trigger="click"
          :width="380"
        >
          <template #reference>
            <el-button :icon="QuestionFilled">
              图例
            </el-button>
          </template>
          <el-descriptions
            title="状态与符号图例"
            :column="1"
            size="small"
            border
          >
            <el-descriptions-item
              label="平台标签"
              width="110"
            >
              品牌色圆点 + 平台名，未接入为灰点
            </el-descriptions-item>
            <el-descriptions-item
              label="脏 N"
              width="110"
            >
              N 处未提交改动
            </el-descriptions-item>
            <el-descriptions-item
              label="未推送 N"
              width="110"
            >
              当前分支领先远程 N 个提交
            </el-descriptions-item>
            <el-descriptions-item
              label="分支待推 N"
              width="110"
            >
              当前分支已同步，但有 N 个分支存在未推送提交
            </el-descriptions-item>
            <el-descriptions-item
              label="N1 / N2"
              width="110"
            >
              未接入：N1 无任何 remote，N2 有 remote 但存在本地独有提交
            </el-descriptions-item>
            <el-descriptions-item
              label="久未动"
              width="110"
            >
              最后提交距今超过 {{ store.staleDays }} 天
            </el-descriptions-item>
            <el-descriptions-item
              label="—"
              width="110"
            >
              无此项
            </el-descriptions-item>
          </el-descriptions>
        </el-popover>
      </div>
    </section>

    <!-- ③ 辅助区（有内容才占位） -->
    <el-alert
      v-if="store.warnings.length > 0"
      type="warning"
      :closable="false"
      show-icon
    >
      <template #title>
        部分仓库采集失败（{{ store.warnings.length }}）
      </template>
      <span
        v-for="(warning, i) in store.warnings"
        :key="i"
        class="warning-line"
      >
        {{ warning }}
      </span>
    </el-alert>

    <!-- ④ 数据区：标题行与表格同处一个面板，避免「卡片套卡片」的双重边框 -->
    <section class="panel">
      <header class="panel-head">
        <h2 class="panel-title">
          仓库列表
        </h2>
        <span class="panel-meta tnum">共 {{ store.repos.length }} 个</span>
      </header>

      <RepoTable
        :repos="store.repos"
        :loading="store.loading"
        @open-git="openGit"
      >
        <!-- 空态要能分诊：一个都没扫到 ≠ 筛选后为空，两者的下一步动作完全不同 -->
        <template #empty>
          <div class="empty-state">
            <template v-if="(store.summary?.total ?? 0) === 0">
              <p class="empty-title">
                还没有扫描到任何仓库
              </p>
              <p class="empty-text">
                当前扫描范围：<span class="mono">{{ scopeSummary }}</span>
              </p>
              <p class="empty-text">
                只识别含 <code class="inline-code">.git</code> 的目录（深度 ≤ {{ store.maxDepth }}），
                隐藏目录与 node_modules 会被跳过。仓库若不在上面的范围里，把它的父目录加进来即可。
              </p>
              <el-button
                type="primary"
                @click="openScanDialog"
              >
                换个目录重新扫描
              </el-button>
            </template>
            <template v-else>
              <p class="empty-title">
                没有匹配的仓库
              </p>
              <p class="empty-text">
                当前筛选条件下没有结果。
              </p>
              <el-button @click="store.resetFilters()">
                清除筛选
              </el-button>
            </template>
          </div>
        </template>
      </RepoTable>
    </section>

    <!-- Git 分支管理：双击行或点操作列 Git 图标打开 -->
    <GitModal
      v-if="gitTarget"
      :repo="gitTarget"
      @close="gitTarget = null"
      @changed="onGitChanged"
    />

    <!-- 扫描范围弹窗：修改后立即重扫，进程内持续生效 -->
    <el-dialog
      v-model="scanDialogVisible"
      title="扫描范围"
      width="560"
    >
      <div class="scan-body">
        <p class="scan-hint">
          每行一个目录，只扫描这些目录及其子目录（绝对路径：
          <code class="inline-code">/Users/code</code>、<code class="inline-code">D:\code</code>、<code class="inline-code">\\server\share</code>，或以 <code class="inline-code">~</code> 开头）。
        </p>
        <el-input
          v-model="rootInput"
          type="textarea"
          :rows="6"
          spellcheck="false"
          placeholder="~/code&#10;~/Projects"
        />
        <div class="scan-pick">
          <el-button
            size="small"
            :loading="store.picking"
            @click="browseDir"
          >
            {{ store.picking ? '请在系统弹窗里选择…' : '选择文件夹…' }}
          </el-button>
          <span class="scan-hint">弹的是系统自带的文件夹选择框，选完自动填进上面的输入框</span>
        </div>
        <div class="scan-suggest">
          <span class="scan-suggest-label">常用位置</span>
          <el-button
            v-for="path in SUGGESTED_ROOTS"
            :key="path"
            link
            type="primary"
            size="small"
            @click="addRoot(path)"
          >
            {{ path }}
          </el-button>
        </div>
        <p class="scan-hint">
          修改后立即按新范围重扫，并在本次服务运行期间保持生效；要长期固定请写入仓库根目录的
          <code class="inline-code">.env</code>（<code class="inline-code">GITVENTORY_SCAN_ROOTS</code>）。
        </p>

        <!-- 不知道该填什么时，把这段交给 AI：本机的「真实工作目录」多半藏在 IDE / 终端的最近记录里 -->
        <div class="scan-ai">
          <p class="scan-hint">
            不知道该填什么？把下面这段发给你的 AI（CodeBuddy / Cursor / Claude Code 都行），
            它会扫一遍常见开发目录，并从 IDE 与终端的「最近打开」记录里翻出你的项目位置。
          </p>
          <el-input
            :model-value="AI_PROMPT"
            type="textarea"
            :rows="9"
            readonly
            spellcheck="false"
            class="scan-ai-prompt"
          />
          <div class="scan-ai-actions">
            <el-button
              size="small"
              @click="copyAiPrompt"
            >
              复制提示词
            </el-button>
            <span class="scan-hint">macOS 与 Windows 的记录路径都写在里面，AI 会自己判断系统</span>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="scanDialogVisible = false">
          取消
        </el-button>
        <el-button
          :loading="store.scanning"
          @click="applyScan(true)"
        >
          恢复默认范围
        </el-button>
        <el-button
          type="primary"
          :loading="store.scanning"
          @click="applyScan(false)"
        >
          重新扫描
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 区块间距统一 16px（规划 §3.1） */
.repo-list-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── ① 概览区 ────────────────────────────── */
.metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}

/* 指标块：白底 + 发丝边框，靠留白分层；不用阴影（dsh 的层次策略） */
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 80px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-bg-layer-1);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.metric:hover {
  background: var(--dsw-interactive-hover);
  border-color: var(--dsw-border-l3);
}

.metric:focus-visible {
  outline: 2px solid var(--dsw-deepseek-300);
  outline-offset: 1px;
}

/* 激活态：品牌蓝 tint 底 + 蓝字，与「品牌色只做强调」的分工一致 */
.metric.is-active {
  background: var(--dsw-tint-accent);
  border-color: var(--dsw-deepseek-300);
}

.metric-label {
  font-size: 12px;
  color: var(--dsw-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.metric-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.02em;
}

.metric.is-active .metric-value {
  color: var(--dsw-accent-strong);
}

.metric-hint {
  margin-top: auto;
  font-size: 11px;
  color: var(--dsw-accent-strong);
}

/* ── ② 工具区 ────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.toolbar-filters,
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.toolbar-actions {
  margin-left: auto;
}

.scanned-at {
  font-size: 12px;
  color: var(--dsw-label-tertiary);
  white-space: nowrap;
}

.filter-search {
  width: 220px;
}

.filter-select {
  width: 128px;
}

/* ── ④ 数据区 ────────────────────────────── */
.panel {
  border: 0.5px solid var(--dsw-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-bg-layer-1);
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--dsw-border-l2);
}

.panel-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.panel-meta {
  font-size: 12px;
  color: var(--dsw-label-tertiary);
}

.warning-line {
  display: block;
  font-size: 12px;
}

/* ── 列设置面板 ────────────────────────────── */
.column-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.column-settings-tip {
  font-size: 12px;
  color: var(--dsw-label-tertiary);
}

.column-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.column-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: var(--dsw-radius-sm);
}

/* 拖拽源：降透明度提示「正在搬运」 */
.column-item.is-dragging {
  opacity: 0.5;
}

.column-item:not(.is-locked):hover {
  background: var(--dsw-interactive-hover);
}

.column-item.is-locked .drag-handle {
  cursor: default;
}

.drag-handle {
  flex: none;
  cursor: grab;
  color: var(--dsw-label-caption);
}

/* 锁定列占位手柄：与可拖拽项左对齐 */
.drag-handle.is-placeholder {
  width: 1em;
}

.column-divider {
  margin: 4px 0;
}

/* 重置按钮靠左贴齐列表，避免在面板里居中悬浮 */
.column-settings > .el-button {
  align-self: flex-start;
  padding-left: 0;
}

/* ── ⓪ 环境告警：语义色 10%+ 底、同色字（dsh 语义色口径）── */
.banner {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 0.5px solid #ec131340;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-tint-danger);
}

.banner-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-danger);
}

.banner-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-danger);
  opacity: 0.85;
}

/* ── 扫描范围 chip ────────────────────────── */
.scope-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  height: 26px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-border-l4);
  border-radius: var(--dsw-radius-pill);
  background: var(--dsw-bg-layer-1);
  color: var(--dsw-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.scope-chip:hover {
  background: var(--dsw-interactive-hover);
}

.scope-chip-label {
  flex: none;
  color: var(--dsw-label-tertiary);
}

.scope-chip-value {
  min-width: 0;
  overflow: hidden;
  font-family: var(--dsw-font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 空态引导：指路，而不只是宣告「没有数据」────── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: 460px;
  margin: 0 auto;
  padding: 24px 16px;
  text-align: center;
}

.empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.empty-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-label-tertiary);
}

.empty-state .el-button {
  margin-top: 8px;
}

/* ── 扫描范围弹窗 ─────────────────────────── */
.scan-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.scan-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-label-tertiary);
}

.inline-code {
  padding: 1px 5px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-neutral-75);
  font-family: var(--dsw-font-mono);
  font-size: 11px;
  color: var(--dsw-label-secondary);
}

/* 「选择文件夹…」：唤起系统选择框，与常用位置按钮区分开单独一行 */
.scan-pick {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 「让 AI 代劳」区块：发丝线分隔 + 弱化层级 —— 它是兜底入口，不是主路径 */
.scan-ai {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-border-l2);
}

.scan-ai-prompt :deep(.el-textarea__inner) {
  font-family: var(--dsw-font-mono);
  font-size: 11px;
  line-height: 1.7;
  color: var(--dsw-label-secondary);
}

.scan-ai-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scan-suggest {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.scan-suggest-label {
  margin-right: 2px;
  font-size: 12px;
  color: var(--dsw-label-tertiary);
}

/* ── 响应式：断点严格按规划 §7.2 ────────────── */
@media (max-width: 1023.98px) {
  .metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 767.98px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .toolbar-actions {
    margin-left: 0;
  }

  .filter-search,
  .filter-select {
    width: 100%;
  }
}
</style>
