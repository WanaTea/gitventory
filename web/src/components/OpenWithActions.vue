<script setup lang="ts">
import type { Repo } from '@shared/repo'
import { iconOf } from '../utils/openTargets'
import { useRepoOpen } from '../composables/useRepoOpen'

/**
 * 「用外部应用打开仓库」按钮组。
 *
 * 列表页操作列与 Git 分支弹窗 header 共用此组件 —— 两处零重复逻辑。
 * 目标清单（顺序 / 文案 / 可用性 / 原因）来自服务端，图标来自前端映射，并发状态来自 useRepoOpen。
 * 宿主只负责把按钮组放到合适位置，组件本身不关心布局。
 */
defineProps<{ repo: Repo }>()

const { targets, isAvailable, isOpening, isBusyOther, tipOf, openWith } = useRepoOpen()
</script>

<template>
  <span class="open-with">
    <el-tooltip
      v-for="target in targets"
      :key="target.id"
      :content="tipOf(target.id)"
      placement="top"
    >
      <!-- 禁用态按钮不派发鼠标事件，包一层 span 保证 tooltip（禁用原因）仍可悬浮显示 -->
      <span class="app-btn-wrap">
        <el-button
          link
          class="icon-btn"
          :loading="isOpening(repo.localId, target.id)"
          :disabled="!isAvailable(target.id) || isBusyOther(repo.localId, target.id)"
          :aria-label="tipOf(target.id)"
          @click="openWith(repo, target.id)"
        >
          <img
            :src="iconOf(target.id)"
            class="app-icon"
            alt=""
          >
        </el-button>
      </span>
    </el-tooltip>
  </span>
</template>

<style scoped>
/* 按钮与图标的尺寸规格走全局类 .icon-btn / .app-icon（theme.css），此处只管排列 */
.open-with {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
</style>
