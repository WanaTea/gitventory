import { createHash } from 'node:crypto';
import type { PlatformType } from '../shared/platform.ts';
import type {
  LinkFilter,
  Repo,
  RepoLink,
  ReposData,
  ReposQuery,
  ReposSummary,
  RepoSort,
  RepoStatus,
  StatusFilter,
  UnlinkedReason,
} from '../shared/repo.ts';
import { config } from '../config/index.ts';
import { classifyLink } from './classify.service.ts';
import type { RepoContext } from './inspect.service.ts';
import { inspectAll } from './inspect.service.ts';
import { resolveRepoPlatform } from './platform.service.ts';
import { discoverRepos } from './scan.service.ts';
import { probeGitAvailable } from '../utils/exec-git.ts';
import { GIT_MISSING_MESSAGE } from '../utils/git-error-text.ts';
import { normalizeRemoteUrl } from '../utils/url-normalize.ts';

function localIdOf(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 12);
}

// 简单 TTL 内存缓存（模块级）
let cache: { at: number; data: ReposData } | null = null;

/**
 * localId → absPath 索引，每次扫描后重建。
 *
 * 存在的意义：写操作会清掉清单缓存，而路由又要按 localId 反查路径；
 * 若反查依赖清单缓存，就等于「每次切分支都先跑一次全量扫描」。
 * 路径索引不随缓存失效而失效 —— 仓库目录不会因为一次 checkout 就搬家。
 */
const pathIndex = new Map<string, string>();

/**
 * 写操作（checkout / pull / push / 删除分支 / 撤销改动）会改变仓库状态，
 * 必须让清单缓存立即失效，否则清单页在 TTL（60s）内仍展示旧状态。
 */
export function invalidateReposCache(): void {
  cache = null;
}

/**
 * 界面设置的扫描范围（进程内有效）。
 *
 * 为什么必须「粘住」：用户在界面上改过范围后，后续每次 /api/repos 都该沿用同一范围。
 * 若只作用于当次请求，60s 缓存一过期就会悄悄退回配置值 —— 表现成「改了，但过一会儿又没了」。
 * 传 null 表示清除覆盖、回到 config.scanRoots。
 */
let activeRoots: string[] | null = null;

export function setScanRoots(roots: readonly string[] | null): void {
  activeRoots = roots === null ? null : [...roots];
  cache = null;
}

/** 当前生效的扫描范围（供 /api/scan 的响应与调试用） */
export function currentScanRoots(): string[] {
  return activeRoots === null ? [...config.scanRoots] : [...activeRoots];
}

export async function getRepos(options: { force?: boolean; roots?: string[] } = {}): Promise<ReposData> {
  const now = Date.now();
  if (options.force !== true && cache !== null && now - cache.at < config.cacheTtlMs) {
    return cache.data;
  }
  const roots = options.roots ?? currentScanRoots();
  const data = await runPipeline(roots);
  cache = { at: now, data };
  rememberPaths(data);
  return data;
}

function rememberPaths(data: ReposData): void {
  for (const item of data.items) {
    pathIndex.set(item.localId, item.absPath);
  }
}

/**
 * 按 localId 反查仓库绝对路径。
 * 路径只可能来自服务端扫描结果（缓存或索引），绝不接受前端传入的路径字符串。
 *
 * 三级查找：本次扫描缓存 → 历史路径索引（写操作清缓存后仍可用）→ 冷启动全量扫描。
 */
export async function resolveRepoPath(localId: string): Promise<string | null> {
  if (cache !== null) {
    const hit = cache.data.items.find((item) => item.localId === localId);
    if (hit !== undefined) return hit.absPath;
  }
  const indexed = pathIndex.get(localId);
  if (indexed !== undefined) return indexed;
  const data = await getRepos();
  return data.items.find((item) => item.localId === localId)?.absPath ?? null;
}

async function runPipeline(roots: readonly string[]): Promise<ReposData> {
  const warnings: string[] = [];
  // 没装 git 时前面所有采集都会静默失败（平台一律「未接入」、改动/分支全空），
  // 看上去像是「你的仓库本来就这样」——必须在结果里说清楚，这也是 warnings 存在的意义。
  const git = await probeGitAvailable();
  if (!git.available) warnings.push(GIT_MISSING_MESSAGE);
  const found = await discoverRepos(roots, warnings);
  const contexts = await inspectAll(found);
  // 时间基准取一次，保证同一次扫描内 stale 判定一致
  const now = Date.now();
  const items = contexts.map((ctx) => buildRepo(ctx, now, config.staleDays));
  return {
    scannedAt: new Date().toISOString(),
    roots: [...roots],
    summary: buildSummary(items),
    items,
    warnings,
  };
}

function buildRepo(ctx: RepoContext, now: number, staleDays: number): Repo {
  const remotes = ctx.remotes.map((r) => {
    const info = normalizeRemoteUrl(r.url);
    return { name: r.name, url: r.url, host: info.host, fullPath: info.fullPath };
  });
  // localOnlyCommits 仅在有 remote 时有意义（无 remote 时 rev-list 会统计全部提交）
  const localOnlyCommits = remotes.length > 0 ? (ctx.localOnlyCommits ?? 0) : 0;
  const link = classifyLink({ hasRemote: remotes.length > 0, localOnlyCommits });
  const platform = resolveRepoPlatform(remotes);
  const absPath = ctx.absPath;
  return {
    localId: localIdOf(absPath),
    name: ctx.name,
    path: absPath,
    absPath,
    platform,
    remotes,
    link,
    status: {
      currentBranch: ctx.status.head,
      dirty: ctx.status.changedCount + ctx.status.untrackedCount > 0,
      changedCount: ctx.status.changedCount,
      untrackedCount: ctx.status.untrackedCount,
      ahead: ctx.status.ahead,
      behind: ctx.status.behind,
      unpushedBranches: ctx.unpushedBranches,
      localOnlyCommits,
      lastCommitAt: ctx.currentBranchLastCommitAt,
      stale: isStale(ctx.currentBranchLastCommitAt, now, staleDays),
    },
    branchCount: ctx.branchCount,
    errors: ctx.errors,
  };
}

function buildSummary(items: readonly Repo[]): ReposSummary {
  const byPlatform: Partial<Record<PlatformType, number>> = {};
  const byUnlinkedReason: Partial<Record<UnlinkedReason, number>> = {};
  let linked = 0;
  let unlinked = 0;
  let dirty = 0;
  let aheadCurrentBranch = 0;
  let unpushedAnyBranch = 0;
  let stale = 0;
  for (const item of items) {
    byPlatform[item.platform.type] = (byPlatform[item.platform.type] ?? 0) + 1;
    if (item.link.status === 'linked') {
      linked++;
    } else {
      unlinked++;
      for (const reason of item.link.reasons) {
        byUnlinkedReason[reason] = (byUnlinkedReason[reason] ?? 0) + 1;
      }
    }
    if (item.status.dirty) dirty++;
    if (item.status.ahead > 0) aheadCurrentBranch++;
    if (item.status.unpushedBranches.length > 0) unpushedAnyBranch++;
    if (item.status.stale) stale++;
  }
  return {
    total: items.length,
    linked,
    unlinked,
    dirty,
    aheadCurrentBranch,
    unpushedAnyBranch,
    stale,
    byPlatform,
    byUnlinkedReason,
  };
}

// ---- 查询（纯函数，无 IO）：筛选 + 排序；summary 始终是全量统计 ----

const DAY_MS = 86_400_000;

/** 长期未动判定：无 lastCommitAt（或不可解析）时返回 false */
export function isStale(lastCommitAt: string | null, now: number, staleDays: number): boolean {
  if (lastCommitAt === null) return false;
  const at = Date.parse(lastCommitAt);
  return Number.isFinite(at) && at < now - staleDays * DAY_MS;
}

/** 应用查询条件，返回新对象；items 为筛选+排序结果，summary/roots/warnings 保持不变 */
export function applyReposQuery(data: ReposData, query: ReposQuery): ReposData {
  const filtered = data.items.filter((item) => matchesQuery(item, query));
  return { ...data, items: sortRepos(filtered, query.sort ?? 'lastActivity') };
}

function matchesQuery(item: Repo, query: ReposQuery): boolean {
  if (query.q !== undefined) {
    const needle = query.q.toLowerCase();
    if (!item.name.toLowerCase().includes(needle) && !item.path.toLowerCase().includes(needle)) {
      return false;
    }
  }
  if (query.platforms !== undefined && !query.platforms.includes(item.platform.type)) {
    return false;
  }
  if (query.links !== undefined && !query.links.some((filter) => matchesLink(item.link, filter))) {
    return false;
  }
  if (query.statuses !== undefined && !query.statuses.some((filter) => matchesStatus(item.status, filter))) {
    return false;
  }
  return true;
}

function matchesLink(link: RepoLink, filter: LinkFilter): boolean {
  if (filter === 'linked') return link.status === 'linked';
  if (filter === 'unlinked') return link.status === 'unlinked';
  return link.reasons.some((reason) => reason === filter);
}

function matchesStatus(status: RepoStatus, filter: StatusFilter): boolean {
  if (filter === 'dirty') return status.dirty;
  // ahead 采用双口径：当前分支 ahead > 0 或任一分支有未推送提交
  if (filter === 'ahead') return status.ahead > 0 || status.unpushedBranches.length > 0;
  return status.stale;
}

function sortRepos(items: readonly Repo[], sort: RepoSort): Repo[] {
  const sorted = [...items];
  if (sort === 'name') {
    sorted.sort((a, b) => compareText(a.name, b.name));
  } else if (sort === 'path') {
    sorted.sort((a, b) => compareText(a.path, b.path));
  } else {
    // lastActivity：最后提交时间倒序，无时间的排最后
    sorted.sort((a, b) => compareTime(b.status.lastCommitAt, a.status.lastCommitAt));
  }
  return sorted;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 时间比较；null / 不可解析统一视为最小，配合倒序排序即排在最后 */
function compareTime(a: string | null, b: string | null): number {
  const ta = a === null ? Number.NaN : Date.parse(a);
  const tb = b === null ? Number.NaN : Date.parse(b);
  const va = Number.isFinite(ta) ? ta : Number.NEGATIVE_INFINITY;
  const vb = Number.isFinite(tb) ? tb : Number.NEGATIVE_INFINITY;
  if (va === vb) return 0;
  return va < vb ? -1 : 1;
}
