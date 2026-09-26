#!/usr/bin/env node
/**
 * 冒烟自检：真的拉起一次服务 → 断言关键不变量 → 收工。
 *
 * 存在的理由：`lint` / `typecheck` / `build` 都是**静态**检查，证明不了「装完能跑起来」。
 * 而本项目的跨平台声明（Windows 的命令探测走 PATHEXT、explorer 的退出码、临时目录路径）
 * 只有真跑一次才碰得到。
 *
 * 做法：在临时目录里用 git 造一个真仓库当扫描根，因此这条自检覆盖
 * 「启动 → 配置解析 → 扫目录 → 采集 git 状态 → 返回 JSON」整条链路。
 * 本地跑：`npm run smoke`（可用 SMOKE_PORT 换端口）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SMOKE_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = fileURLToPath(new URL('../server/src/index.ts', import.meta.url));
const scanRoot = mkdtempSync(join(tmpdir(), 'gitventory-smoke-'));
const expectedRootName = basename(scanRoot);

/** 造一个真仓库：git 采集链路必须被真正走一遍，否则这条自检只是「HTTP 能通」 */
function seedRepo(dir) {
  // mkdtempSync 只建了扫描根，仓库目录要自己建 —— 缺目录时 execFileSync 也报 ENOENT，
  // 看起来像「找不到 git」，很容易把人带偏
  mkdirSync(dir, { recursive: true });
  let run;
  try {
    run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf-8' });
    run('init', '-q', '-b', 'main');
  } catch (err) {
    throw new Error(
      `准备临时仓库失败（需要本机可用的 git）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  writeFileSync(join(dir, 'README.md'), '# smoke\n');
  run('add', '-A');
  run('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', 'commit', '-qm', 'init');
}

const failures = [];
let logs = '';
let server;

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return (await res.json()).data;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`服务在 30s 内未就绪，日志：\n${logs}`);
}

try {
  seedRepo(join(scanRoot, 'demo-repo'));
  server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), GITVENTORY_SCAN_ROOTS: scanRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  server.stderr.on('data', (chunk) => {
    logs += chunk;
  });

  const health = await waitForHealth();
  check('服务启动并响应 /api/health', true, `platform=${health.platform}`);
  check('git 可用', health.git.available === true, health.git.version ?? '未检测到 git');
  check(
    '扫描根按配置生效',
    Array.isArray(health.roots) && health.roots.some((root) => basename(root) === expectedRootName),
    health.roots.join(', '),
  );
  check(
    '打开方式已解析出目标',
    Array.isArray(health.openTargets) && health.openTargets.length > 0,
    `${health.openTargets.length} 个`,
  );
  check(
    '每个目标都带可用性原因字段',
    health.openTargets.every((item) => typeof item.available === 'boolean' && typeof item.label === 'string'),
  );

  const repos = await getJson('/api/repos');
  const items = repos.body?.data?.items ?? [];
  check('扫描到临时目录里的仓库', items.length === 1, `items=${items.length}`);
  check('采集到当前分支', items[0]?.status?.currentBranch === 'main', items[0]?.status?.currentBranch ?? '');
  check('读取到该仓库的本地路径', typeof items[0]?.absPath === 'string' && items[0].absPath !== '');

  const notFound = await getJson('/api/definitely-not-here');
  check('/api 未匹配路径返回 JSON 404', notFound.status === 404 && notFound.body?.code === 404);

  const root = await fetch(`${BASE}/`);
  check('根路径可达（有 web/dist 时即前端页面）', root.status < 500, `http ${root.status}`);
} catch (err) {
  check('冒烟自检执行完成', false, err instanceof Error ? err.message : String(err));
} finally {
  server?.kill();
  rmSync(scanRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n冒烟自检失败：${failures.length} 项 → ${failures.join('，')}`);
  process.exitCode = 1;
} else {
  console.log('\n冒烟自检通过');
}
