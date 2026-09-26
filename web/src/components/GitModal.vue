<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowRight, Check, Refresh, Search } from '@element-plus/icons-vue'
import type { Repo } from '@shared/repo'
import type { GitBranchRef, GitCommit, GitStatusData } from '@shared/git'
import {
  checkoutGitBranch,
  checkoutGitRemoteBranch,
  deleteGitBranches,
  deleteGitRemoteBranches,
  fetchGitRemote,
  getGitBranches,
  getGitCommits,
  getGitStatus,
  pullGitBranch,
  pushGitBranch,
  pushGitBranchToRemote,
  restoreGitFiles,
} from '../api'
import { formatDateTime, relativeTime } from '../utils/format'
import OpenWithActions from './OpenWithActions.vue'

/**
 * Git 分支弹窗：把 workspace-dash 的 git-modal 能力整体搬过来，交互与功能保持等价，
 * 外观按本项目规范（Element Plus + dsh 令牌）重做。
 *
 * 用法：父组件用 `v-if` 控制挂载，每次打开都是全新实例（原版靠 open() 手写 20 个字段复位）。
 */
const props = defineProps<{ repo: Repo }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const COMMIT_PAGE_SIZE = 30

// ---- 分支列表 ----
const loading = ref(true)
const error = ref('')
/** fetch 降级说明（无 remote / 网络不通时仍展示本地引用） */
const warning = ref('')
const current = ref('')
const remoteUrl = ref('')
const local = ref<GitBranchRef[]>([])
const remote = ref<GitBranchRef[]>([])
const localSearch = ref('')
const remoteSearch = ref('')
const refreshingLocal = ref(false)
const refreshingRemote = ref(false)
const branchLoading = ref('')
const branchError = ref('')

// ---- 提交记录（展开分支时按需分页加载）----
interface CommitState {
  list: GitCommit[]
  hasMore: boolean
  loading: boolean
  error: string
  loaded: boolean
}
const expanded = ref<Record<string, boolean>>({})
const commitsMap = ref<Record<string, CommitState>>({})

// ---- 工作区状态 ----
const status = ref<GitStatusData | null>(null)
const syncLoading = ref(false)
const syncError = ref('')
const switchingBranch = ref('')
const checkoutError = ref('')
const selectedMap = ref<Record<string, boolean>>({})
/**
 * 删除失败信息。
 * 「整批中止」与「部分成功」语义完全不同 —— 前者一个都没删（例如入参被拒），
 * 后者已删掉一部分，标题必须分开，否则会误导用户以为删了一半。
 */
const deleteFailure = ref<{ kind: 'partial' | 'failed'; text: string } | null>(null)

// ---- 撤销文件改动 ----
const restoreVisible = ref(false)
const restoreSelected = ref<Record<string, boolean>>({})
const restoreAllChecked = ref(true)
const restoring = ref(false)
const restoreError = ref('')

// ---- 派生 ----

const localNameSet = computed<Set<string>>(() => new Set(local.value.map((b) => b.name)))

const filteredLocal = computed(() => filterBranches(local.value, localSearch.value))
const filteredRemote = computed(() => filterBranches(remote.value, remoteSearch.value))

/** 当前分支不能被删除，也不参与勾选 */
const selectableLocal = computed(() => filteredLocal.value.filter((b) => b.name !== current.value))

// 只统计「检索后可见」的勾选，避免误删看不见的分支
const selectedLocal = computed(() => selectableLocal.value.filter((b) => selectedMap.value[`l:${b.name}`]))
const selectedRemote = computed(() => filteredRemote.value.filter((b) => selectedMap.value[`r:${b.name}`]))

const allLocalChecked = computed(
  () => selectableLocal.value.length > 0 && selectedLocal.value.length === selectableLocal.value.length,
)
const allRemoteChecked = computed(
  () => filteredRemote.value.length > 0 && selectedRemote.value.length === filteredRemote.value.length,
)

/** SSH / 本地路径远程地址不能当网页打开，只有 http(s) 才给链接 */
const remoteHref = computed(() => (/^https?:\/\//i.test(remoteUrl.value) ? remoteUrl.value : ''))

const changedFiles = computed(() => status.value?.changes ?? [])
const selectedRestoreCount = computed(() => changedFiles.value.filter((c) => restoreSelected.value[c.file]).length)

const aheadBehindLabel = computed(() => {
  const s = status.value
  if (!s) return ''
  const parts: string[] = []
  if (s.behind > 0) parts.push(`落后 ${s.behind}`)
  if (s.ahead > 0) parts.push(`领先 ${s.ahead}`)
  return parts.join(' · ')
})

// ---- 读取 ----

async function loadBranches(initial = false): Promise<void> {
  if (initial) loading.value = true
  error.value = ''
  try {
    const data = await getGitBranches(props.repo.localId)
    applyBranches(data)
  } catch (e) {
    error.value = errorText(e, '获取分支失败')
  } finally {
    loading.value = false
    refreshingLocal.value = false
  }
}

async function loadStatus(): Promise<void> {
  try {
    status.value = await getGitStatus(props.repo.localId)
  } catch {
    // 状态卡是辅助信息，失败不打断分支列表
    status.value = null
  }
}

/** fetch --prune：拉取远程引用后刷新列表（失败时带 warning 降级） */
async function refreshRemote(): Promise<void> {
  if (refreshingRemote.value) return
  refreshingRemote.value = true
  error.value = ''
  warning.value = ''
  try {
    applyBranches(await fetchGitRemote(props.repo.localId))
  } catch (e) {
    error.value = errorText(e, '拉取远程分支失败')
  } finally {
    refreshingRemote.value = false
    refreshingLocal.value = false
  }
}

/** 仅重读本地分支（不起网络请求） */
async function refreshLocal(): Promise<void> {
  if (refreshingLocal.value) return
  refreshingLocal.value = true
  error.value = ''
  warning.value = ''
  try {
    applyBranches(await getGitBranches(props.repo.localId))
  } catch (e) {
    error.value = errorText(e, '刷新本地分支失败')
  } finally {
    refreshingLocal.value = false
  }
}

function applyBranches(data: {
  current: string
  remoteUrl: string
  local: GitBranchRef[]
  remote: GitBranchRef[]
  warning?: string
}): void {
  current.value = data.current
  remoteUrl.value = data.remoteUrl
  local.value = data.local
  remote.value = data.remote
  warning.value = data.warning ?? ''
  // 勾选状态按新列表收敛，避免删掉的分支残留勾选
  const next: Record<string, boolean> = {}
  for (const b of data.local) if (selectedMap.value[`l:${b.name}`]) next[`l:${b.name}`] = true
  for (const b of data.remote) if (selectedMap.value[`r:${b.name}`]) next[`r:${b.name}`] = true
  selectedMap.value = next
  // 已展开的分支重载首屏提交，避免展示过期数据
  for (const key of Object.keys(expanded.value)) void loadCommits(key, key.slice(2), false)
}

// ---- 提交记录 ----

function isExpanded(key: string): boolean {
  return expanded.value[key] === true
}

function toggleExpand(key: string): void {
  if (isExpanded(key)) {
    expanded.value[key] = false
    return
  }
  expanded.value[key] = true
  const state = commitsMap.value[key]
  // 已加载过则用缓存；上次失败的允许重试
  if (!state || !state.loaded || state.error !== '') void loadCommits(key, key.slice(2), false)
}

function commitsOf(key: string): GitCommit[] {
  return commitsMap.value[key]?.list ?? []
}
function commitsLoading(key: string): boolean {
  return commitsMap.value[key]?.loading === true
}
function commitsHasMore(key: string): boolean {
  return commitsMap.value[key]?.hasMore === true
}
function commitsLoaded(key: string): boolean {
  return commitsMap.value[key]?.loaded === true
}
function commitsError(key: string): string {
  return commitsMap.value[key]?.error ?? ''
}

async function loadCommits(key: string, ref: string, more: boolean): Promise<void> {
  // ⚠️ 必须先写入 map、再从 map 里取回：直接持有刚 new 出来的原始对象，
  // 后续在 await 之后修改它不会经过响应式代理，视图会一直停在「加载中」。
  if (commitsMap.value[key] === undefined) {
    commitsMap.value[key] = { list: [], hasMore: true, loading: false, error: '', loaded: false }
  }
  const state: CommitState = commitsMap.value[key]
  if (state.loading) return
  if (more && !state.hasMore) return
  const skip = more ? state.list.length : 0
  state.loading = true
  state.error = ''
  try {
    const data = await getGitCommits(props.repo.localId, ref, skip, COMMIT_PAGE_SIZE)
    state.list = more ? state.list.concat(data.commits) : data.commits
    state.hasMore = data.hasMore
    state.loaded = true
  } catch (e) {
    state.error = errorText(e, '加载提交失败')
    state.loaded = true
  } finally {
    state.loading = false
  }
}

// ---- 分支操作 ----

/** 切换/签出/推送等操作成功后统一刷新分支与状态 */
async function afterWrite(): Promise<void> {
  emit('changed')
  await Promise.all([loadBranches(), loadStatus()])
}

async function checkout(branch: string): Promise<void> {
  if (branch === current.value || switchingBranch.value !== '') return
  switchingBranch.value = branch
  checkoutError.value = ''
  try {
    await checkoutGitBranch(props.repo.localId, branch)
    ElMessage.success(`已切换到 ${branch}`)
    await afterWrite()
  } catch (e) {
    checkoutError.value = errorText(e, '切换失败')
  } finally {
    switchingBranch.value = ''
  }
}

async function checkoutRemote(branch: string): Promise<void> {
  if (branchLoading.value !== '') return
  branchLoading.value = `${branch}:checkoutRemote`
  branchError.value = ''
  try {
    const data = await checkoutGitRemoteBranch(props.repo.localId, branch)
    ElMessage.success(`已签出到 ${data.branch ?? branch}`)
    await afterWrite()
  } catch (e) {
    branchError.value = errorText(e, '签出失败')
  } finally {
    branchLoading.value = ''
  }
}

async function pushBranchToRemote(branch: string): Promise<void> {
  if (branchLoading.value !== '') return
  branchLoading.value = `${branch}:pushRemote`
  branchError.value = ''
  try {
    await pushGitBranchToRemote(props.repo.localId, branch)
    ElMessage.success(`已推送 ${branch} 到远端`)
    await afterWrite()
  } catch (e) {
    branchError.value = errorText(e, '推送失败')
  } finally {
    branchLoading.value = ''
  }
}

async function pullBranch(): Promise<void> {
  if (syncLoading.value) return
  syncLoading.value = true
  syncError.value = ''
  try {
    await pullGitBranch(props.repo.localId)
    ElMessage.success('拉取完成')
    await afterWrite()
  } catch (e) {
    syncError.value = errorText(e, '拉取失败')
  } finally {
    syncLoading.value = false
  }
}

async function pushBranch(): Promise<void> {
  if (syncLoading.value) return
  syncLoading.value = true
  syncError.value = ''
  try {
    await pushGitBranch(props.repo.localId)
    ElMessage.success('推送完成')
    await afterWrite()
  } catch (e) {
    syncError.value = errorText(e, '推送失败')
  } finally {
    syncLoading.value = false
  }
}

// ---- 选择与删除 ----

function toggleSelect(key: string, value: boolean): void {
  selectedMap.value[key] = value
}

function toggleSelectAllLocal(value: boolean): void {
  for (const b of selectableLocal.value) selectedMap.value[`l:${b.name}`] = value
}

function toggleSelectAllRemote(value: boolean): void {
  for (const b of filteredRemote.value) selectedMap.value[`r:${b.name}`] = value
}

function clearSelected(scope: 'local' | 'remote'): void {
  const prefix = `${scope === 'local' ? 'l' : 'r'}:`
  for (const key of Object.keys(selectedMap.value)) {
    if (key.startsWith(prefix)) selectedMap.value[key] = false
  }
}

/** 删除前置确认：单条与批量共用，删除远程额外强调不可撤销 */
async function requestDelete(scope: 'local' | 'remote', items: string[]): Promise<void> {
  if (branchLoading.value !== '' || items.length === 0) return
  const isLocal = scope === 'local'
  const title = isLocal ? '确认删除本地分支' : '确认删除远程分支'
  const target =
    items.length === 1
      ? `确定要删除 ${items[0]} 吗？`
      : `确定要删除以下 ${items.length} 个分支吗？\n${items.join('\n')}`
  const note = isLocal
    ? '（仅删除本地分支，未合并的分支会失败；不影响远程）'
    : '（将执行 git push --delete，删除后团队成员都会同步消失，不可撤销）'
  try {
    await ElMessageBox.confirm(`${target}\n\n${note}`, title, {
      type: 'warning',
      confirmButtonText: `删除(${items.length})`,
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      customClass: 'gitventory-confirm',
    })
  } catch {
    return // 用户取消
  }
  await runDelete(scope, items)
}

async function runDelete(scope: 'local' | 'remote', items: string[]): Promise<void> {
  branchLoading.value = `delete:${scope}`
  deleteFailure.value = null
  try {
    const data =
      scope === 'local'
        ? await deleteGitBranches(props.repo.localId, items)
        : await deleteGitRemoteBranches(props.repo.localId, items)
    if (data.failed.length === 0) {
      ElMessage.success(`已删除 ${data.deleted.length} 个分支`)
    } else {
      // 部分成功：已删的生效，失败项留在提示里，勾选保持不变便于重试
      deleteFailure.value = { kind: 'partial', text: formatBatchFailure(data.failed) }
      ElMessage.error(`删除失败 ${data.failed.length} 个，成功 ${data.deleted.length} 个`)
    }
    if (data.deleted.length > 0) clearSelected(scope)
    await afterWrite()
  } catch (e) {
    // 整个请求被拒（入参校验不通过等）：一个都没删，标题不能写「部分分支删除失败」
    deleteFailure.value = { kind: 'failed', text: errorText(e, '删除失败') }
  } finally {
    branchLoading.value = ''
  }
}

function formatBatchFailure(failed: { name: string; error: string }[]): string {
  return failed
    .map((f) => `${f.name}（${f.error.replace(/^(error|fatal):\s*/i, '')}）`)
    .join('；')
}

// ---- 撤销文件改动 ----

function openRestore(): void {
  if (changedFiles.value.length === 0) return
  const selected: Record<string, boolean> = {}
  for (const c of changedFiles.value) selected[c.file] = true
  restoreSelected.value = selected
  restoreAllChecked.value = true
  restoreError.value = ''
  restoreVisible.value = true
}

function toggleRestoreAll(value: boolean): void {
  const selected: Record<string, boolean> = {}
  for (const c of changedFiles.value) selected[c.file] = value
  restoreSelected.value = selected
  restoreAllChecked.value = value
}

function toggleRestoreFile(file: string, value: boolean): void {
  restoreSelected.value[file] = value
  restoreAllChecked.value = changedFiles.value.every((c) => restoreSelected.value[c.file] === true)
}

async function confirmRestore(): Promise<void> {
  const files = changedFiles.value.filter((c) => restoreSelected.value[c.file]).map((c) => c.file)
  if (files.length === 0 || restoring.value) return
  restoring.value = true
  restoreError.value = ''
  try {
    await restoreGitFiles(props.repo.localId, files)
    ElMessage.success(`已撤销 ${files.length} 个文件的改动`)
    restoreVisible.value = false
    emit('changed')
    await loadStatus()
  } catch (e) {
    restoreError.value = errorText(e, '撤销失败')
  } finally {
    restoring.value = false
  }
}

// ---- 展示辅助 ----

function filterBranches(list: GitBranchRef[], keyword: string): GitBranchRef[] {
  const kw = keyword.trim().toLowerCase()
  if (kw === '') return list
  return list.filter((b) => b.name.toLowerCase().includes(kw))
}

function remoteLocalName(remoteRef: string): string {
  const idx = remoteRef.indexOf('/')
  return idx === -1 ? remoteRef : remoteRef.slice(idx + 1)
}

/** 远程分支已有同名本地分支时不再提供「签出」 */
function isLocalBranch(remoteRef: string): boolean {
  return localNameSet.value.has(remoteLocalName(remoteRef))
}

/** porcelain 状态码 → 中文短标签 */
function statusChar(code: string): string {
  if (code === '') return ''
  if (code.includes('A')) return '新增'
  if (code.includes('D')) return '删除'
  if (code.includes('R')) return '重命名'
  if (code.includes('M')) return '修改'
  return code
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message !== '' ? e.message : fallback
}

/** 弹窗由父组件 v-if 挂载，关闭动作（✕ / ESC）统一通知父组件卸载，状态随之自然重置 */
function onVisibleChange(value: boolean): void {
  if (!value) emit('close')
}

onMounted(() => {
  void loadStatus()
  void loadBranches(true)
})
</script>

<template>
  <el-dialog
    :model-value="true"
    width="960px"
    top="6vh"
    :close-on-click-modal="false"
    class="git-dialog"
    @update:model-value="onVisibleChange"
  >
    <template #header>
      <div class="git-head">
        <div class="git-head-text">
          <div class="git-head-main">
            <span class="git-title">{{ repo.name }}</span>
            <span
              v-if="current"
              class="git-chip mono"
            >
              当前 {{ current }}
            </span>
          </div>
          <a
            v-if="remoteHref !== ''"
            class="git-remote mono"
            :href="remoteHref"
            target="_blank"
            rel="noopener noreferrer"
            :title="remoteUrl"
          >
            {{ remoteUrl }}
          </a>
          <span
            v-else-if="remoteUrl !== ''"
            class="git-remote mono is-plain"
            :title="remoteUrl"
          >
            {{ remoteUrl }}
          </span>
        </div>
        <!-- 打开目标与列表页共用同一组件（规划 11 §4）：对象是仓库而不是分支，故放 header -->
        <OpenWithActions
          :repo="repo"
          class="git-head-actions"
        />
      </div>
    </template>

    <div
      v-if="loading"
      class="git-loading"
    >
      <el-skeleton
        :rows="6"
        animated
      />
    </div>

    <el-alert
      v-else-if="error"
      type="error"
      :closable="false"
      show-icon
      :title="error"
    />

    <template v-else>
      <!-- 状态卡：左分支与改动概览，右常用同步动作 -->
      <div class="git-status">
        <div class="git-status-left">
          <span class="git-status-branch mono">{{ current || '(detached HEAD)' }}</span>
          <el-tag
            v-if="status === null"
            type="info"
            size="small"
          >
            状态读取中
          </el-tag>
          <template v-else-if="status">
            <el-tag
              v-if="status.hasChanges"
              type="warning"
              size="small"
              disable-transitions
            >
              有改动 {{ status.changedCount }}
            </el-tag>
            <el-tag
              v-else
              type="success"
              size="small"
              disable-transitions
            >
              无改动
            </el-tag>
            <el-tag
              v-if="status.untrackedCount > 0"
              type="info"
              size="small"
              disable-transitions
            >
              未跟踪 {{ status.untrackedCount }}
            </el-tag>
            <el-tag
              v-if="aheadBehindLabel !== ''"
              type="danger"
              size="small"
              disable-transitions
            >
              {{ aheadBehindLabel }}
            </el-tag>
            <el-tag
              v-else-if="status.upstream !== ''"
              type="info"
              size="small"
              disable-transitions
            >
              已同步
            </el-tag>
            <span
              v-if="status.upstream !== ''"
              class="git-upstream mono"
            >
              {{ status.upstream }}
            </span>
          </template>
        </div>
        <div class="git-status-right">
          <el-button
            v-if="status?.hasChanges"
            size="small"
            @click="openRestore"
          >
            撤销改动
          </el-button>
          <el-button
            size="small"
            :loading="syncLoading"
            :disabled="syncLoading"
            @click="pullBranch"
          >
            拉取
          </el-button>
          <el-button
            size="small"
            type="primary"
            :loading="syncLoading"
            :disabled="syncLoading"
            @click="pushBranch"
          >
            推送
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="warning !== ''"
        class="git-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="warning"
      />
      <el-alert
        v-if="syncError !== ''"
        class="git-alert"
        type="error"
        show-icon
        :title="syncError"
        @close="syncError = ''"
      />
      <el-alert
        v-if="branchError !== ''"
        class="git-alert"
        type="error"
        show-icon
        :title="branchError"
        @close="branchError = ''"
      />
      <el-alert
        v-if="checkoutError !== ''"
        class="git-alert"
        type="error"
        show-icon
        :title="checkoutError"
        @close="checkoutError = ''"
      />
      <el-alert
        v-if="deleteFailure !== null"
        class="git-alert"
        type="error"
        show-icon
        :title="deleteFailure.kind === 'partial' ? '部分分支删除失败' : '删除失败（未删除任何分支）'"
        :description="deleteFailure.text"
        @close="deleteFailure = null"
      />

      <!-- 本地 / 远程两列 -->
      <div class="git-columns">
        <section class="git-col">
          <header class="git-col-head">
            <span class="git-col-title">本地分支</span>
            <span class="git-count tnum">{{ local.length }}</span>
            <el-button
              class="git-refresh"
              link
              :icon="Refresh"
              :loading="refreshingLocal"
              :disabled="refreshingLocal"
              title="刷新本地分支"
              @click="refreshLocal"
            />
            <span class="git-col-tools">
              <el-checkbox
                v-if="selectableLocal.length > 0"
                :model-value="allLocalChecked"
                @update:model-value="(v: boolean | string | number) => toggleSelectAllLocal(!!v)"
              >
                全选
              </el-checkbox>
              <el-button
                v-if="selectedLocal.length > 0"
                link
                class="git-batch-del"
                :disabled="branchLoading !== ''"
                @click="requestDelete('local', selectedLocal.map((b) => b.name))"
              >
                删除({{ selectedLocal.length }})
              </el-button>
            </span>
          </header>
          <el-input
            v-model="localSearch"
            :prefix-icon="Search"
            size="small"
            placeholder="检索本地分支"
            clearable
          />

          <div class="git-list">
            <el-empty
              v-if="filteredLocal.length === 0"
              :image-size="60"
              :description="local.length > 0 ? '无匹配分支' : '暂无本地分支'"
            />
            <div
              v-for="b in filteredLocal"
              :key="`l:${b.name}`"
              class="git-branch-block"
            >
              <div
                class="git-branch"
                :class="{ 'is-current': b.name === current, 'is-open': isExpanded(`l:${b.name}`) }"
                :title="b.name"
                @click="toggleExpand(`l:${b.name}`)"
              >
                <span
                  class="git-pick"
                  @click.stop
                >
                  <el-checkbox
                    v-if="b.name !== current"
                    :model-value="!!selectedMap[`l:${b.name}`]"
                    @update:model-value="(v: boolean | string | number) => toggleSelect(`l:${b.name}`, !!v)"
                  />
                </span>
                <el-icon
                  v-if="b.name === current"
                  class="git-check"
                >
                  <Check />
                </el-icon>
                <span
                  v-else
                  class="git-check"
                />
                <span class="git-name mono">{{ b.name }}</span>
                <span class="git-time tnum">{{ relativeTime(b.updatedAt) }}</span>
                <span
                  class="git-row-ops"
                  @click.stop
                >
                  <el-button
                    v-if="b.name !== current"
                    link
                    class="git-op"
                    :loading="switchingBranch === b.name"
                    :disabled="switchingBranch !== '' || branchLoading !== ''"
                    @click="checkout(b.name)"
                  >
                    切换
                  </el-button>
                  <el-button
                    link
                    class="git-op"
                    :loading="branchLoading === `${b.name}:pushRemote`"
                    :disabled="branchLoading !== ''"
                    @click="pushBranchToRemote(b.name)"
                  >
                    推送
                  </el-button>
                  <el-button
                    link
                    class="git-op is-danger"
                    :loading="branchLoading === `delete:local`"
                    :disabled="branchLoading !== '' || b.name === current"
                    :title="b.name === current ? '当前分支不能删除' : `删除本地分支 ${b.name}`"
                    @click="requestDelete('local', [b.name])"
                  >
                    删除
                  </el-button>
                </span>
                <el-icon
                  class="git-arrow"
                  :class="{ 'is-open': isExpanded(`l:${b.name}`) }"
                >
                  <ArrowRight />
                </el-icon>
              </div>

              <div
                v-if="isExpanded(`l:${b.name}`)"
                class="git-commits"
              >
                <template v-if="commitsOf(`l:${b.name}`).length > 0">
                  <div
                    v-for="(c, ci) in commitsOf(`l:${b.name}`)"
                    :key="ci"
                    class="git-commit"
                  >
                    <div class="git-commit-subject">
                      {{ c.subject }}
                    </div>
                    <div class="git-commit-meta">
                      {{ c.author }} · {{ relativeTime(c.time) }}
                      <span class="git-commit-time tnum">{{ formatDateTime(c.time) }}</span>
                    </div>
                  </div>
                </template>
                <div
                  v-if="commitsLoading(`l:${b.name}`) && commitsOf(`l:${b.name}`).length === 0"
                  class="git-hint"
                >
                  正在加载提交…
                </div>
                <div
                  v-else-if="commitsError(`l:${b.name}`) !== ''"
                  class="git-hint is-error"
                >
                  {{ commitsError(`l:${b.name}`) }}
                </div>
                <div
                  v-else-if="commitsLoaded(`l:${b.name}`) && commitsOf(`l:${b.name}`).length === 0"
                  class="git-hint"
                >
                  暂无提交
                </div>
                <el-button
                  v-if="commitsHasMore(`l:${b.name}`)"
                  link
                  class="git-more"
                  :loading="commitsLoading(`l:${b.name}`)"
                  @click.stop="loadCommits(`l:${b.name}`, b.name, true)"
                >
                  {{ commitsLoading(`l:${b.name}`) ? '加载中…' : '加载更多提交' }}
                </el-button>
                <div
                  v-else-if="commitsOf(`l:${b.name}`).length > 0"
                  class="git-hint"
                >
                  已全部加载（共 {{ commitsOf(`l:${b.name}`).length }} 条）
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="git-col">
          <header class="git-col-head">
            <span class="git-col-title">远程分支</span>
            <span class="git-count tnum">{{ remote.length }}</span>
            <el-button
              class="git-refresh"
              link
              :icon="Refresh"
              :loading="refreshingRemote"
              :disabled="refreshingRemote"
              title="拉取远程分支（git fetch --prune）"
              @click="refreshRemote"
            />
            <span class="git-col-tools">
              <el-checkbox
                v-if="filteredRemote.length > 0"
                :model-value="allRemoteChecked"
                @update:model-value="(v: boolean | string | number) => toggleSelectAllRemote(!!v)"
              >
                全选
              </el-checkbox>
              <el-button
                v-if="selectedRemote.length > 0"
                link
                class="git-batch-del"
                :disabled="branchLoading !== ''"
                @click="requestDelete('remote', selectedRemote.map((b) => b.name))"
              >
                删除({{ selectedRemote.length }})
              </el-button>
            </span>
          </header>
          <el-input
            v-model="remoteSearch"
            :prefix-icon="Search"
            size="small"
            placeholder="检索远程分支"
            clearable
          />

          <div class="git-list">
            <el-empty
              v-if="filteredRemote.length === 0"
              :image-size="60"
              :description="remote.length > 0 ? '无匹配分支' : '暂无远程分支'"
            />
            <div
              v-for="b in filteredRemote"
              :key="`r:${b.name}`"
              class="git-branch-block"
            >
              <div
                class="git-branch"
                :class="{ 'is-open': isExpanded(`r:${b.name}`) }"
                :title="b.name"
                @click="toggleExpand(`r:${b.name}`)"
              >
                <span
                  class="git-pick"
                  @click.stop
                >
                  <el-checkbox
                    :model-value="!!selectedMap[`r:${b.name}`]"
                    @update:model-value="(v: boolean | string | number) => toggleSelect(`r:${b.name}`, !!v)"
                  />
                </span>
                <span class="git-check" />
                <span class="git-name mono">{{ b.name }}</span>
                <span class="git-time tnum">{{ relativeTime(b.updatedAt) }}</span>
                <span
                  class="git-row-ops"
                  @click.stop
                >
                  <el-button
                    v-if="!isLocalBranch(b.name)"
                    link
                    class="git-op"
                    :loading="branchLoading === `${b.name}:checkoutRemote`"
                    :disabled="branchLoading !== ''"
                    @click="checkoutRemote(b.name)"
                  >
                    签出
                  </el-button>
                  <el-button
                    link
                    class="git-op is-danger"
                    :loading="branchLoading === `delete:remote`"
                    :disabled="branchLoading !== ''"
                    @click="requestDelete('remote', [b.name])"
                  >
                    删除
                  </el-button>
                </span>
                <el-icon
                  class="git-arrow"
                  :class="{ 'is-open': isExpanded(`r:${b.name}`) }"
                >
                  <ArrowRight />
                </el-icon>
              </div>

              <div
                v-if="isExpanded(`r:${b.name}`)"
                class="git-commits"
              >
                <template v-if="commitsOf(`r:${b.name}`).length > 0">
                  <div
                    v-for="(c, ci) in commitsOf(`r:${b.name}`)"
                    :key="ci"
                    class="git-commit"
                  >
                    <div class="git-commit-subject">
                      {{ c.subject }}
                    </div>
                    <div class="git-commit-meta">
                      {{ c.author }} · {{ relativeTime(c.time) }}
                      <span class="git-commit-time tnum">{{ formatDateTime(c.time) }}</span>
                    </div>
                  </div>
                </template>
                <div
                  v-if="commitsLoading(`r:${b.name}`) && commitsOf(`r:${b.name}`).length === 0"
                  class="git-hint"
                >
                  正在加载提交…
                </div>
                <div
                  v-else-if="commitsError(`r:${b.name}`) !== ''"
                  class="git-hint is-error"
                >
                  {{ commitsError(`r:${b.name}`) }}
                </div>
                <div
                  v-else-if="commitsLoaded(`r:${b.name}`) && commitsOf(`r:${b.name}`).length === 0"
                  class="git-hint"
                >
                  暂无提交
                </div>
                <el-button
                  v-if="commitsHasMore(`r:${b.name}`)"
                  link
                  class="git-more"
                  :loading="commitsLoading(`r:${b.name}`)"
                  @click.stop="loadCommits(`r:${b.name}`, b.name, true)"
                >
                  {{ commitsLoading(`r:${b.name}`) ? '加载中…' : '加载更多提交' }}
                </el-button>
                <div
                  v-else-if="commitsOf(`r:${b.name}`).length > 0"
                  class="git-hint"
                >
                  已全部加载（共 {{ commitsOf(`r:${b.name}`).length }} 条）
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>

    <template #footer>
      <el-button @click="emit('close')">
        关闭
      </el-button>
    </template>

    <!-- 撤销文件改动：勾选式二级弹窗 -->
    <el-dialog
      v-model="restoreVisible"
      title="撤销文件改动"
      width="620px"
      append-to-body
      :close-on-click-modal="false"
    >
      <p class="git-restore-hint">
        勾选要撤销的文件，将恢复到最近一次提交；未跟踪文件不受影响。
      </p>
      <el-alert
        v-if="restoreError !== ''"
        class="git-alert"
        type="error"
        show-icon
        :title="restoreError"
      />
      <div class="git-restore-list">
        <div class="git-restore-all">
          <el-checkbox
            :model-value="restoreAllChecked"
            @update:model-value="(v: boolean | string | number) => toggleRestoreAll(!!v)"
          >
            全选
          </el-checkbox>
        </div>
        <!-- 整行可点，但勾选框自身要 stop，避免与外层点击叠加成两次切换 -->
        <div
          v-for="c in changedFiles"
          :key="c.file"
          class="git-restore-item"
          @click="toggleRestoreFile(c.file, !restoreSelected[c.file])"
        >
          <el-checkbox
            :model-value="!!restoreSelected[c.file]"
            @click.stop
            @update:model-value="(v: boolean | string | number) => toggleRestoreFile(c.file, !!v)"
          />
          <span class="git-restore-status">{{ statusChar(c.status) }}</span>
          <span
            class="git-restore-file mono"
            :title="c.file"
          >
            {{ c.file }}
          </span>
          <span class="git-restore-time tnum">{{ c.mtime ? relativeTime(c.mtime) : '—' }}</span>
        </div>
      </div>
      <template #footer>
        <el-button
          :disabled="restoring"
          @click="restoreVisible = false"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="restoring"
          :disabled="restoring || selectedRestoreCount === 0"
          @click="confirmRestore"
        >
          撤销({{ selectedRestoreCount }})
        </el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
/* ── 头部 ─────────────────────────────────────── */
/* 左右两段：左 = 仓库名 / 当前分支 / remote；右 = 「用外部应用打开」按钮组（位置 A，规划 11 §6） */
.git-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
  /* el-dialog 的关闭按钮绝对定位在右上角，动作组要避让 */
  padding-right: 28px;
}

.git-head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.git-head-actions {
  flex: none;
}

.git-head-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.git-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.git-chip {
  padding: 1px 8px;
  border: 0.5px solid var(--dsw-border-l4);
  border-radius: var(--dsw-radius-pill);
  color: var(--dsw-label-tertiary);
  font-size: 11px;
}

.git-remote {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-accent);
  text-decoration: none;
}

.git-remote.is-plain {
  color: var(--dsw-label-caption);
}

.git-remote:hover {
  text-decoration: underline;
}

/* ── 状态卡 ───────────────────────────────────── */
.git-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-border-l2);
  border-radius: var(--dsw-radius-lg);
}

.git-status-left,
.git-status-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.git-status-right {
  margin-left: auto;
}

.git-status-branch {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-label-primary);
}

.git-upstream {
  color: var(--dsw-label-caption);
}

.git-alert {
  margin-top: 8px;
}

/* ── 两列分支 ─────────────────────────────────── */
.git-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 12px;
}

.git-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.git-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.git-col-title {
  font-size: 13px;
  font-weight: 600;
}

.git-count {
  padding: 1px 7px;
  border-radius: var(--dsw-radius-pill);
  background: var(--dsw-neutral-60);
  color: var(--dsw-label-secondary);
  font-size: 11px;
}

.git-refresh {
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--dsw-label-caption);
}

.git-col-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.git-batch-del {
  color: var(--dsw-danger);
  font-size: 12px;
}

/* 分支列表：固定高度内滚动，避免长列表把弹窗撑到屏幕外 */
.git-list {
  display: flex;
  flex-direction: column;
  min-height: 260px;
  max-height: 380px;
  overflow-y: auto;
  padding: 4px;
  border: 0.5px solid var(--dsw-border-l2);
  border-radius: var(--dsw-radius-md);
}

.git-branch-block {
  display: flex;
  flex-direction: column;
}

.git-branch {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}

.git-branch:hover {
  background: var(--dsw-interactive-hover);
}

.git-branch.is-current .git-name {
  color: var(--dsw-accent-strong);
  font-weight: 500;
}

.git-branch.is-open {
  background: var(--dsw-interactive-hover);
}

.git-pick {
  display: inline-flex;
  flex: none;
  width: 18px;
  justify-content: center;
}

.git-check {
  flex: none;
  width: 14px;
  color: var(--dsw-success);
  font-size: 13px;
}

.git-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.git-time {
  flex: none;
  color: var(--dsw-label-caption);
  font-size: 11px;
}

.git-row-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.git-op {
  height: 22px;
  padding: 0 6px;
  color: var(--dsw-label-tertiary);
  font-size: 11px;
}

.git-op:hover:not(.is-disabled) {
  color: var(--dsw-label-primary);
  background: var(--dsw-interactive-active);
}

.git-op.is-danger:hover:not(.is-disabled) {
  color: var(--dsw-danger);
}

.git-arrow {
  flex: none;
  color: var(--dsw-label-caption);
  font-size: 12px;
  transition: transform 0.15s ease;
}

.git-arrow.is-open {
  transform: rotate(90deg);
}

/* ── 提交记录 ─────────────────────────────────── */
.git-commits {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 2px 0 6px 24px;
  padding-left: 10px;
  border-left: 0.5px solid var(--dsw-border-l3);
}

.git-commit-subject {
  font-size: 12px;
  color: var(--dsw-label-secondary);
  word-break: break-word;
}

.git-commit-meta {
  margin-top: 2px;
  color: var(--dsw-label-caption);
  font-size: 11px;
}

.git-commit-time {
  margin-left: 6px;
}

.git-hint {
  color: var(--dsw-label-caption);
  font-size: 11px;
}

.git-hint.is-error {
  color: var(--dsw-danger);
}

.git-more {
  align-self: flex-start;
  font-size: 11px;
}

/* ── 撤销对话框 ───────────────────────────────── */
.git-restore-hint {
  margin: 0 0 8px;
  color: var(--dsw-label-tertiary);
  font-size: 12px;
}

.git-restore-list {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
  border: 0.5px solid var(--dsw-border-l2);
  border-radius: var(--dsw-radius-md);
}

.git-restore-all {
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-border-l2);
  background: var(--dsw-neutral-50);
}

.git-restore-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
}

.git-restore-item:hover {
  background: var(--dsw-interactive-hover);
}

.git-restore-status {
  flex: none;
  width: 38px;
  color: var(--dsw-label-tertiary);
  font-size: 11px;
}

.git-restore-file {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.git-restore-time {
  flex: none;
  color: var(--dsw-label-caption);
  font-size: 11px;
}

.git-loading {
  padding: 8px 4px;
}

@media (max-width: 900px) {
  .git-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<style>
/* ElMessageBox 内容被 teleport 到 body，且 message 用换行排版，故走全局样式 */
.gitventory-confirm .el-message-box__message p {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.6;
}
</style>
