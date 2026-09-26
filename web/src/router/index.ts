import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'repo-list',
      component: () => import('../views/RepoListView.vue'),
    },
  ],
})

export default router
