<script setup lang="ts">
import { computed } from 'vue'
import { PLATFORM_LABELS } from '@shared/platform'

const props = defineProps<{
  type: string
  label: string
  host?: string
}>()

/*
 * 品牌色只用来点一个 6px 圆点，不做满底色块。
 * 原因：平台列与「状态」「未接入」列在截图里都是同款灰底/实心标签，三处同色导致语义层级塌陷；
 * dsh 的做法是实心色块只留给真正需要抢占注意力的语义态，类型标识一律走克制描边。
 */
const COLORS: Record<string, string> = {
  github: '#181717',
  gitlab: '#fc6d26',
  gitee: '#c71d23',
  codeup: '#ff6a00',
  coding: '#0052d9',
  other: '#909399',
  none: '#c0c4cc',
}

const isNone = computed(() => props.type === 'none')
const dotColor = computed(() => COLORS[props.type] ?? COLORS.other)
const displayLabel = computed(() =>
  isNone.value
    ? '未接入'
    : props.label || PLATFORM_LABELS[props.type as keyof typeof PLATFORM_LABELS] || props.type,
)
</script>

<template>
  <div class="platform-tag">
    <span class="platform-pill">
      <span
        class="platform-dot"
        :style="{ background: dotColor }"
      />
      {{ displayLabel }}
    </span>
    <span
      v-if="!isNone && host"
      class="platform-host mono"
    >
      {{ host }}
    </span>
  </div>
</template>

<style scoped>
.platform-tag {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}

/* 描边 pill（dsh tag[data-tone=outline]）+ 品牌色圆点 */
.platform-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 19px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-border-l4);
  border-radius: var(--dsw-radius-pill);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  color: var(--dsw-label-secondary);
  white-space: nowrap;
}

.platform-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.platform-host {
  max-width: 100%;
  color: var(--dsw-label-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
