import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ApiResponse } from './shared/api.ts';
import { config } from './config/index.ts';
import { errorHandler } from './middleware/error-handler.ts';
import { router } from './routes/index.ts';
import { probeGitAvailable } from './utils/exec-git.ts';
import { GIT_MISSING_MESSAGE } from './utils/git-error-text.ts';

const app = express();

app.use(express.json());
app.use('/api', router);

// /api 下未匹配的路径保持 JSON 语义：既不该落到前端的 SPA 兜底，也不该是 Express 的 HTML 404
app.use('/api', (_req, res) => {
  const payload: ApiResponse<null> = { code: 404, data: null, message: '接口不存在' };
  res.status(404).json(payload);
});

/**
 * 生产形态：同一个端口既服务 API，也服务前端构建产物（web/dist）。
 * 开发时用 `npm run dev`（vite 负责热更新与 /api 代理），这里只在 dist 存在时挂载。
 *
 * 路径基于**本文件位置**解析，不依赖启动时的工作目录 —— 从仓库根或 server/ 启动都成立。
 */
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const hasWebDist = existsSync(join(webDist, 'index.html'));

if (hasWebDist) {
  app.use(express.static(webDist));
  // SPA 兜底：非 /api 的 GET 回 index.html 交给前端路由；/api 的 404 仍走 JSON
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path === '/api' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(join(webDist, 'index.html'));
  });
} else {
  // 只有 API 时，给直接访问根路径的人一句可操作的话（否则是 Express 默认的 "Cannot GET /"）
  app.get('/', (_req, res) => {
    res
      .type('text/plain; charset=utf-8')
      .send(
        '未找到 web/dist（前端构建产物）。\n开发模式：npm run dev\n生产模式：npm run build 后重启本服务\n',
      );
  });
}

app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`[gitventory] server listening at http://${config.host}:${config.port}`);
  console.log(
    `[gitventory] scan roots: ${config.scanRoots.join(', ')} (maxDepth=${config.maxDepth})`,
  );
  console.log(
    hasWebDist
      ? '[gitventory] 已托管 web/dist，直接打开上面的地址即可'
      : '[gitventory] 未找到 web/dist，当前仅提供 API（前端请用 npm run dev）',
  );
  void reportGitAvailability();
});

// 端口占用是「拉下来跑不起来」最常见的原因之一：默认的 EADDRINUSE 堆栈看不出该怎么办
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[gitventory] 端口 ${config.port} 已被占用：可能已经有一个实例在运行。` +
        '关闭它，或用 PORT 换一个端口（前端 vite 的代理也要同步改）。',
    );
    process.exitCode = 1;
    return;
  }
  throw err;
});

/**
 * 启动预检：git 缺失时当场说清楚。
 * 否则用户看到的是「所有仓库都判定为未接入、没有任何改动」——像是数据本身如此，而不是环境缺东西。
 */
async function reportGitAvailability(): Promise<void> {
  const git = await probeGitAvailable();
  if (git.available) {
    console.log(`[gitventory] ${git.version ?? 'git'} ✓`);
    return;
  }
  console.warn(`[gitventory] ⚠️  ${GIT_MISSING_MESSAGE}`);
  console.warn('[gitventory] ⚠️  平台、改动状态与分支信息将无法采集');
}
