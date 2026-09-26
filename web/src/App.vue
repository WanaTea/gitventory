<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="app-brand">
        <span class="app-title">Gitventory</span>
        <span class="app-sub">本地优先 · 多仓库盘点</span>
      </div>
      <nav class="app-nav">
        <RouterLink
          to="/"
          class="nav-item"
          :class="{ 'is-active': route.name === 'repo-list' }"
        >
          仓库清单
        </RouterLink>
      </nav>
    </header>

    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
/* 应用外壳：56px 顶栏 + 发丝分隔线，内容区 24px 内边距（规划 §2 / §3） */
.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  position: sticky;
  top: 0;
  z-index: 10;
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 24px;
  background: var(--dsw-bg-base);
  border-bottom: 0.5px solid var(--dsw-border-l2);
}

.app-brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.app-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.app-sub {
  font-size: 12px;
  color: var(--dsw-label-tertiary);
  white-space: nowrap;
}

.app-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

/* 导航项 = pill：active 用浅灰实底，hover 用交互叠加色（dsh sidebar-nav 口径） */
.nav-item {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--dsw-radius-pill);
  color: var(--dsw-label-secondary);
  font-size: 13px;
  text-decoration: none;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.nav-item:hover {
  background: var(--dsw-interactive-hover);
  color: var(--dsw-label-primary);
}

.nav-item.is-active {
  background: var(--dsw-neutral-100);
  color: var(--dsw-label-primary);
  font-weight: 500;
}

.app-main {
  flex: 1;
  min-height: 0;
  padding: 24px;
}

@media (max-width: 768px) {
  .app-header {
    padding: 0 16px;
  }

  .app-sub {
    display: none;
  }

  .app-main {
    padding: 16px;
  }
}
</style>
