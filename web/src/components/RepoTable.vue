<script setup lang="ts">
import type { Repo } from '@shared/repo'
import PlatformTag from './PlatformTag.vue'
import OpenWithActions from './OpenWithActions.vue'
import { useRepoColumns } from '../composables/useRepoColumns'
import { formatDateTime } from '../utils/format'

defineProps<{
  repos: Repo[]
  loading: boolean
}>()

// Git 分支管理弹窗由列表页统一承载：这里只负责把「哪个仓库」抛上去
const emit = defineEmits<{ openGit: [repo: Repo] }>()

// 列配置与「列表页的列设置面板」共用同一份单例状态；解构为顶层 ref 以便模板自动解包
const { visible: visibleColumns } = useRepoColumns()

// 代码类文本列（路径 / Remote / 分支）走等宽字体：这类值逐字符比对，比例字体只是徒增噪音
const MONO_KEYS = new Set(['path', 'remote', 'branch'])

function columnClass(key: string): string {
  return MONO_KEYS.has(key) ? 'cell-mono' : ''
}

/**
 * 双击行打开 Git 分支管理。
 * 落在按钮/链接/输入框上的双击不触发 —— 那是在连点「操作」列，不是要打开弹窗。
 *
 * ⚠️ el-table 的 row-dblclick 回调签名是 (row, column, event)，
 * 第二个参数是列对象而不是事件，取错就会让守护条件永远不成立。
 */
function onRowDblClick(repo: Repo, _column: unknown, event: Event): void {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('button, a, input, label') !== null) return
  emit('openGit', repo)
}

function originUrl(repo: Repo): string {
  const origin = repo.remotes?.find((r) => r.name === 'origin') ?? repo.remotes?.[0]
  return origin?.url ?? '—'
}

// 「分支待推」：当前分支已同步（ahead === 0），但仍有分支存在未推送提交
function hasUnpushedBranches(repo: Repo): boolean {
  const s = repo.status
  return !!s && s.ahead === 0 && (s.unpushedBranches?.length ?? 0) > 0
}

function hasAnyStatus(repo: Repo): boolean {
  const s = repo.status
  if (!s) return false
  return s.dirty || s.ahead > 0 || s.stale || hasUnpushedBranches(repo)
}
</script>

<template>
  <!-- 首次加载：骨架占位（保持表格高度，避免布局跳动） -->
  <el-skeleton
    v-if="loading && repos.length === 0"
    :rows="10"
    animated
  />

  <el-table
    v-else
    v-loading="loading"
    :data="repos"
    size="small"
    row-key="localId"
    class="repo-table"
    @row-dblclick="onRowDblClick"
  >
    <!--
      动态列：顺序与可见性由 useRepoColumns 提供（工具区「列设置」面板可调）。
      列头排序用 el-table 内置排序（前端排序），可排序列见 REPO_COLUMNS 的 sortable。
      不使用 border 属性：完整网格会让 73 行数据的视觉权重全部相等，改用水平发丝线分行。
    -->
    <el-table-column
      v-for="col in visibleColumns"
      :key="col.key"
      :prop="col.prop"
      :label="col.label"
      :width="col.width"
      :min-width="col.minWidth"
      :align="col.align"
      :header-align="col.headerAlign"
      :fixed="col.fixed"
      :sortable="col.sortable"
      :sort-by="col.sortBy"
      :show-overflow-tooltip="col.ellipsis"
      :class-name="columnClass(col.key)"
    >
      <template #default="{ row }">
        <PlatformTag
          v-if="col.key === 'platform'"
          :type="row.platform?.type"
          :label="row.platform?.label"
          :host="row.platform?.host"
        />
        <el-space
          v-else-if="col.key === 'status'"
          :size="4"
          wrap
        >
          <el-tooltip
            v-if="row.status?.dirty"
            :content="`已跟踪改动 ${row.status.changedCount ?? 0} · 未跟踪文件 ${row.status.untrackedCount ?? 0}`"
            placement="top"
          >
            <el-tag
              type="warning"
              size="small"
              disable-transitions
            >
              脏 {{ (row.status.changedCount ?? 0) + (row.status.untrackedCount ?? 0) }}
            </el-tag>
          </el-tooltip>
          <el-tag
            v-if="(row.status?.ahead ?? 0) > 0"
            type="danger"
            size="small"
            disable-transitions
          >
            未推送 {{ row.status.ahead }}
          </el-tag>
          <el-tooltip
            v-else-if="hasUnpushedBranches(row)"
            :content="`待推分支：${row.status.unpushedBranches.join('、')}`"
            placement="top"
          >
            <el-tag
              type="info"
              size="small"
              disable-transitions
            >
              分支待推 {{ row.status.unpushedBranches.length }}
            </el-tag>
          </el-tooltip>
          <el-tag
            v-if="row.status?.stale"
            size="small"
            disable-transitions
            class="tag-outline"
          >
            久未动
          </el-tag>
          <span
            v-if="!hasAnyStatus(row)"
            class="cell-empty"
          >
            —
          </span>
        </el-space>
        <el-space
          v-else-if="col.key === 'link'"
          :size="4"
        >
          <template v-if="row.link?.status === 'unlinked' && row.link.reasons?.length">
            <!-- 「未接入」是事实而非告警：用描边徽标，与状态列的语义色块区分开 -->
            <el-tag
              v-for="reason in row.link.reasons"
              :key="reason"
              size="small"
              disable-transitions
              class="tag-outline"
            >
              {{ reason }}
            </el-tag>
          </template>
          <span
            v-else
            class="cell-empty"
          >
            —
          </span>
        </el-space>
        <el-space
          v-else-if="col.key === 'actions'"
          :size="2"
        >
          <!-- Git 分支管理入口：双击整行是快捷方式，这里给可见入口 -->
          <el-tooltip
            content="Git 分支管理（双击行同样可打开）"
            placement="top"
          >
            <span class="app-btn-wrap">
              <el-button
                link
                class="icon-btn git-entry"
                aria-label="Git 分支管理"
                @click="emit('openGit', row)"
              >
                <svg
                  class="app-icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <circle
                    cx="4.6"
                    cy="3.4"
                    r="1.7"
                  />
                  <circle
                    cx="4.6"
                    cy="12.6"
                    r="1.7"
                  />
                  <circle
                    cx="11.4"
                    cy="6.4"
                    r="1.7"
                  />
                  <path d="M4.6 5.1v5.8" />
                  <path d="M11.4 8.1c0 2.1-1.7 3.1-3.5 3.1H6.4" />
                </svg>
              </el-button>
            </span>
          </el-tooltip>
          <!-- 「用外部应用打开」按钮组：与 Git 分支弹窗 header 共用同一组件（规划 11） -->
          <OpenWithActions :repo="row" />
        </el-space>
        <template v-else-if="col.key === 'remote'">
          {{ originUrl(row) }}
        </template>
        <template v-else-if="col.key === 'branch'">
          {{ row.status?.currentBranch || '—' }}
        </template>
        <template v-else-if="col.key === 'lastCommit'">
          {{ formatDateTime(row.status?.lastCommitAt ?? '') }}
        </template>
        <template v-else-if="col.key === 'path'">
          {{ row.path }}
        </template>
        <template v-else>
          <span class="cell-strong">{{ row.name }}</span>
        </template>
      </template>
    </el-table-column>

    <!-- 空态由宿主决定：列表页知道扫描范围与筛选条件，能区分「一个都没扫到」与「筛选后为空」 -->
    <template #empty>
      <slot name="empty">
        <el-empty
          description="没有匹配的仓库"
          :image-size="80"
        />
      </slot>
    </template>
  </el-table>
</template>

<style scoped>
.repo-table {
  width: 100%;
}

/* 密度：紧凑行高，一屏尽量多看（规划 §7.1） */
.repo-table :deep(td.el-table__cell) {
  padding: 5px 0;
}

/* 仓库名是横向滚动时的视觉锚点，给足字重与对比度 */
.cell-strong {
  font-weight: 500;
  color: var(--dsw-label-primary);
}

/* 空值统一走最弱的字色，避免与真实值抢注意力 */
.cell-empty {
  color: var(--dsw-label-caption);
}

.repo-table :deep(.cell-mono .cell) {
  font-family: var(--dsw-font-mono);
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--dsw-label-tertiary);
}

/* tooltip 包裹层 / 图标尺寸 / 图标按钮热区规格已提为全局类（theme.css），此处不再重复 */

/* Git 入口是行内主操作（近黑），其余图标是「用别的应用打开」的次操作 */
.repo-table :deep(.el-button.git-entry) {
  color: var(--dsw-label-primary);
}
</style>
