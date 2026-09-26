import { Router } from 'express';
import { config } from '../config/index.ts';
import { API_ERROR } from '../shared/api.ts';
import { PLATFORM_TYPES } from '../shared/platform.ts';
import {
  LINK_FILTERS,
  REPO_SORTS,
  STATUS_FILTERS,
  type OpenRepoResult,
  type ReposQuery,
} from '../shared/repo.ts';
import { openRepo, resolveOpenTargets } from '../services/open-targets.service.ts';
import {
  applyReposQuery,
  getRepos,
  resolveRepoPath,
  setScanRoots,
} from '../services/repo.service.ts';
import { probeGitAvailable } from '../utils/exec-git.ts';
import { expandHome, isAbsolutePath } from '../utils/path.ts';
import { fail, respond } from '../utils/respond.ts';
import { gitRouter } from './git.ts';

// M1 范围：GET /api/health、GET /api/repos、POST /api/scan；增强：POST /api/repos/:localId/open
// Git 分支弹窗：见 routes/git.ts（挂载于 /repos/:localId）
export const router = Router();

router.get('/health', async (_req, res) => {
  respond(res, {
    status: 'ok',
    // 让前端知道「哪些功能在本机不可能可用」（外部应用打开仅 macOS）
    platform: process.platform,
    git: await probeGitAvailable(),
    roots: config.scanRoots,
    maxDepth: config.maxDepth,
    dataDir: config.dataDir,
    cacheTtlMs: config.cacheTtlMs,
    staleDays: config.staleDays,
    openTargets: resolveOpenTargets(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

router.get('/repos', async (req, res) => {
  const force = req.query.refresh === 'true';
  const data = await getRepos({ force });
  // summary 始终是全量统计，仅 items 受查询条件影响
  respond(res, applyReposQuery(data, parseReposQuery(req.query)));
});

router.post('/scan', async (req, res) => {
  const override = parseRootsOverride(req.body);
  if (override.action === 'invalid') {
    fail(res, 400, 400, override.reason);
    return;
  }
  if (override.action === 'set') setScanRoots(override.roots);
  if (override.action === 'reset') setScanRoots(null);
  const data = await getRepos({ force: true });
  respond(res, data);
});

// 用外部应用打开仓库：路径由服务端按 localId 反查，不接受前端传路径。
// 可用目标与命令都来自配置（config/open-targets.json + 内置默认），按当前平台判定。
router.post('/repos/:localId/open', async (req, res) => {
  const targets = resolveOpenTargets();
  const target = parseOpenTarget(req.body, targets.map((item) => item.id));
  if (target === null) {
    fail(res, 400, 400, `参数 target 非法，可选值：${targets.map((item) => item.id).join(' / ')}`);
    return;
  }
  const info = targets.find((item) => item.id === target);
  if (info !== undefined && !info.available) {
    // 原因来自配置解析（缺该平台命令 / 未装应用 / 命令不在 PATH），直接透出，避免两处措辞打架
    fail(res, 501, 501, `无法${info.label}：${info.reason ?? '当前系统不可用'}`);
    return;
  }
  const localId = req.params.localId as string;
  const absPath = await resolveRepoPath(localId);
  if (absPath === null) {
    fail(res, 404, 404, `未找到该仓库：${localId}`);
    return;
  }
  try {
    await openRepo(target, absPath);
  } catch (err) {
    fail(res, 500, API_ERROR, `打开失败（${info?.label ?? target}）：${errorText(err)}`);
    return;
  }
  const data: OpenRepoResult = { opened: target, path: absPath };
  respond(res, data);
});

// Git 分支弹窗：分支/提交/状态 + checkout/pull/push/删除分支/撤销（路径同样由 localId 反查）
router.use('/repos/:localId', gitRouter);

function parseOpenTarget(body: unknown, allowed: readonly string[]): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { target?: unknown }).target;
  if (typeof value !== 'string') return null;
  return allowed.find((item) => item === value) ?? null;
}

/**
 * 解析 /api/scan 的扫描范围覆盖。
 * - 未提供 roots：不动当前范围，仅重扫（action: 'keep'）；
 * - 提供非空数组：设为该范围（action: 'set'）；
 * - 提供空数组：清除界面设置的覆盖，回到配置的扫描根（action: 'reset'）。
 *
 * 「空数组 = 恢复默认」这条契约必须让前端能表达，否则用户改坏范围后只能重启服务。
 */
type RootsOverride =
  | { action: 'keep' }
  | { action: 'set'; roots: string[] }
  | { action: 'reset' }
  | { action: 'invalid'; reason: string };

function parseRootsOverride(body: unknown): RootsOverride {
  if (typeof body !== 'object' || body === null) return { action: 'keep' };
  const roots = (body as { roots?: unknown }).roots;
  if (!Array.isArray(roots)) return { action: 'keep' };
  const list = roots
    .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
    .map((r) => expandHome(r.trim()));
  if (list.length === 0) return { action: 'reset' };
  const relative = list.find((r) => !isAbsolutePath(r));
  if (relative !== undefined) {
    return { action: 'invalid', reason: `扫描范围必须是绝对路径（或以 ~ 开头）：${relative}` };
  }
  return { action: 'set', roots: list };
}

// ---- 查询参数解析（HTTP 边界；缺省/空值/非法值一律忽略，不回错）----

function parseReposQuery(query: unknown): ReposQuery {
  const source: Record<string, unknown> =
    typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
  const q = queryText(source.q).trim();
  return {
    q: q === '' ? undefined : q,
    platforms: parseEnumList(source.platform, PLATFORM_TYPES),
    links: parseEnumList(source.link, LINK_FILTERS),
    statuses: parseEnumList(source.status, STATUS_FILTERS),
    sort: parseEnumList(source.sort, REPO_SORTS)?.[0],
  };
}

/** 兼容 ?a=1,2 与 ?a=1&a=2（数组）两种写法，非字符串一律视为空 */
function queryText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').join(',');
  }
  return '';
}

/** 逗号分隔多值 → 字典枚举（大小写不敏感）；无有效值则视为未传该参数 */
function parseEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const raw = queryText(value);
  if (raw === '') return undefined;
  const picked = new Set<T>();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    const hit = allowed.find((item) => item.toLowerCase() === token);
    if (hit !== undefined) picked.add(hit);
  }
  return picked.size > 0 ? [...picked] : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
