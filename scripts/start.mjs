#!/usr/bin/env node
/**
 * 一键启动：把「clone 之后要用起来」所需的步骤串成一条命令。
 *
 * 覆盖：版本检查 → git 检查 → 装依赖 → 构建前端 → 起服务 → 打开浏览器。
 * 已经做过的步骤会跳过，所以第二次运行等于直接启动。
 *
 * 为什么不用 shell 脚本：Windows 的 cmd / PowerShell 跑不了 .sh，
 * 而维护两份脚本迟早会漂移。Node 是本项目本来就要求的运行时，直接用它。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const PORT = Number(process.env.PORT) || 8787;
const URL = `http://127.0.0.1:${PORT}`;

/** 日志前缀与服务端保持一致，方便在终端里一起看 */
const log = (msg) => console.log(`[gitventory] ${msg}`);
const fail = (msg) => {
  console.error(`[gitventory] ${msg}`);
  process.exit(1);
};

/** 同步跑一条命令；失败就带着原始退出码退出 */
function step(cmd, args, label) {
  log(label);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) fail(`${label}失败：${r.error.message}`);
  if (r.status !== 0) fail(`${label}失败（exit ${r.status}）。上面是原始输出，按它修即可。`);
}

// 1. Node 版本：engines 里写的是最低门槛，这里按它校验
const engines = pkg.engines?.node ?? '>=22.18';
const min = engines.match(/(\d+)\.(\d+)/);
const [curMajor, curMinor] = process.versions.node.split('.').map(Number);
if (min) {
  const ok =
    curMajor > Number(min[1]) ||
    (curMajor === Number(min[1]) && curMinor >= Number(min[2]));
  if (!ok) {
    fail(
      `Node 版本不够：需要 ${engines}，当前 ${process.versions.node}。\n` +
        `  用 nvm：nvm install && nvm use（.nvmrc 已固定版本）\n` +
        `  版本过低会抛 ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"，` +
        `因为服务端直接用 node 跑 TypeScript。`,
    );
  }
}
log(`Node ${process.versions.node} ✓`);

// 2. git：整个工具建立在调用本机 git 之上，缺了它扫描结果全是错的
const git = spawnSync('git', ['--version'], { stdio: 'pipe' });
if (git.error || git.status !== 0) {
  fail('没找到 git。这个工具直接调用你本机的 git，请先安装并在 PATH 里可用。');
}
log(`${git.stdout.toString().trim()} ✓`);

// 3. 依赖
if (!existsSync(path.join(root, 'node_modules'))) {
  step(npm, ['install'], '首次运行，正在安装依赖…');
} else {
  log('依赖已就绪 ✓');
}

// 4. 前端产物：npm start 只起服务端，dist 存在时才会被同一端口托管
if (!existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  step(npm, ['run', 'build'], '首次运行，正在构建前端…');
} else {
  log('前端产物已就绪 ✓');
}

// 5. 先确认端口是空的。
//    放在起服务之前：否则服务起不来、但健康检查打到占用端口的那个实例上，
//    会误报「已就绪」，用户看到的是一串 npm error，很难懂。
await new Promise((resolve) => {
  const probe = net
    .connect(PORT, '127.0.0.1')
    .setTimeout(1500)
    .once('connect', () => {
      probe.destroy();
      fail(
        `端口 ${PORT} 已被占用，可能已经有一个 Gitventory 在跑。\n` +
          `  要么关掉它（pkill -f "scripts/dev.mjs" 或 pkill -f "src/index.ts"），\n` +
          `  要么换端口：PORT=8899 npm run launch`,
      );
    })
    .once('timeout', () => {
      probe.destroy();
      resolve();
    })
    .once('error', () => resolve());
});

log(`正在启动，稍等一下…（地址 ${URL}）`);

// 5. 起服务（前台运行，Ctrl+C 即停）
const server = spawn(npm, ['start'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
server.on('exit', (code) => process.exit(code ?? 0));

// 6. 等服务真的能应答了再开浏览器 —— 直接开的话大概率撞上一个还没监听的端口
const deadline = Date.now() + 30_000;
const openWhenReady = async () => {
  try {
    const res = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(String(res.status));
    open(URL);
    log(`已就绪：${URL}`);
    return;
  } catch {
    if (Date.now() < deadline) setTimeout(openWhenReady, 500);
    else log(`服务已启动，但健康检查超时。手动打开 ${URL} 看看。`);
  }
};

function open(target) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  // 打开浏览器是锦上添花，失败不该影响服务本身
  spawn(cmd, [target], { stdio: 'ignore' }).on('error', () => {});
}

openWhenReady();
