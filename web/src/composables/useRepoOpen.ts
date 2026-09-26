import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'
import { ElMessage } from 'element-plus'
import type { OpenTargetInfo, Repo } from '@shared/repo'
import { openRepo } from '../api'
import { useRepoStore } from '../stores/repo'

/**
 * 「用外部应用打开仓库」的共用逻辑。
 *
 * 目标清单、展示名、可用性与不可用原因**全部来自服务端**（/api/health.openTargets，
 * 由 config/open-targets.json + 内置默认按当前平台解析）—— 前端只负责渲染与并发控制，
 * 因此换平台或加自定义应用都不需要动前端。
 *
 * 状态作用域 = **模块级共享**，key 为 `${localId}:${target}`：
 * 同一个仓库会同时出现在列表页某一行与分支弹窗 header，两处必须读同一份「进行中」状态，
 * 否则会出现「列表页点了 Finder，弹窗里同一仓库的按钮仍可点」→ 同一仓库并发发两次 open。
 *
 * ⚠️ 只能通过 ref 代理修改（`openingKeys.value.add(...)`）。先 new 一个对象再塞进响应式容器、
 * 之后修改那个原始对象，改动不经过代理 → 视图不更新（本项目已在 GitModal 提交分页上踩过一次）。
 */
const openingKeys = ref<Set<string>>(new Set())

function keyOf(localId: string, target: string): string {
  return `${localId}:${target}`
}

export function useRepoOpen(): {
  targets: ComputedRef<OpenTargetInfo[]>
  isAvailable: (target: string) => boolean
  isOpening: (localId: string, target: string) => boolean
  isBusyOther: (localId: string, target: string) => boolean
  tipOf: (target: string) => string
  openWith: (repo: Repo, target: string) => Promise<void>
} {
  const store = useRepoStore()

  // 顺序即服务端给出的顺序（对象键序那种隐式契约已删除）
  const targets = computed<OpenTargetInfo[]>(() => store.openTargets)
  const byId = computed<Map<string, OpenTargetInfo>>(
    () => new Map(store.openTargets.map((item) => [item.id, item])),
  )

  function infoOf(target: string): OpenTargetInfo | undefined {
    return byId.value.get(target)
  }

  function labelOf(target: string): string {
    return infoOf(target)?.label ?? target
  }

  function isAvailable(target: string): boolean {
    return infoOf(target)?.available ?? false
  }

  /** tooltip：可用时就是动作名本身；不可用时直接展示服务端给的原因（与后端 501 同一句） */
  function tipOf(target: string): string {
    const info = infoOf(target)
    if (info === undefined) return target
    return info.available ? info.label : `${info.label}：${info.reason ?? '当前系统不可用'}`
  }

  function isOpening(localId: string, target: string): boolean {
    return openingKeys.value.has(keyOf(localId, target))
  }

  /** 同一仓库的另一个动作正在进行 → 本按钮也禁用（避免一次点出多个应用） */
  function isBusyOther(localId: string, target: string): boolean {
    const prefix = `${localId}:`
    const current = keyOf(localId, target)
    for (const key of openingKeys.value) {
      if (key !== current && key.startsWith(prefix)) return true
    }
    return false
  }

  async function openWith(repo: Repo, target: string): Promise<void> {
    const key = keyOf(repo.localId, target)
    if (openingKeys.value.has(key)) return
    openingKeys.value.add(key)
    try {
      await openRepo(repo.localId, target)
      // 成功文案由服务端下发的 label 拼出：'在 Finder 中打开' → '已在 Finder 中打开 X'
      ElMessage.success(`已${labelOf(target)} ${repo.name}`)
    } catch (e) {
      ElMessage.error(e instanceof Error && e.message !== '' ? e.message : '打开失败')
    } finally {
      openingKeys.value.delete(key)
    }
  }

  return { targets, isAvailable, isOpening, isBusyOther, tipOf, openWith }
}
