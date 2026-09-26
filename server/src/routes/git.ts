import { Router, type Request } from 'express';
import { invalidateReposCache, resolveRepoPath } from '../services/repo.service.ts';
import * as ops from '../services/git-ops.service.ts';
import { GIT_COMMIT_PAGE_SIZE } from '../shared/git.ts';
import { GitOpError } from '../utils/git-op-error.ts';
import { respond } from '../utils/respond.ts';

/**
 * Git 分支弹窗接口，挂载于 /api/repos/:localId（见 routes/index.ts）。
 *
 * 两条边界：
 * 1. 路径一律由 localId 反查扫描结果，前端永远不传目录字符串（与 /open 同策略）；
 * 2. 任何写操作成功后必须让扫描缓存失效，否则清单页在 TTL 内仍显示旧状态。
 */
export const gitRouter = Router({ mergeParams: true });

// ---- 只读 ----

gitRouter.get('/branches', async (req, res) => {
  respond(res, await ops.readBranches(await repoPath(req)));
});

gitRouter.get('/status', async (req, res) => {
  respond(res, await ops.readStatus(await repoPath(req)));
});

gitRouter.get('/commits', async (req, res) => {
  const ref = queryText(req, 'ref');
  if (ref === '') throw new GitOpError(400, '缺少参数 ref');
  respond(
    res,
    await ops.readCommits(
      await repoPath(req),
      ref,
      toInt(queryText(req, 'skip'), 0),
      toInt(queryText(req, 'limit'), GIT_COMMIT_PAGE_SIZE),
    ),
  );
});

// ---- 写操作 ----

/** fetch 只更新远程引用，不改工作区，但会改变 ahead/behind → 一并失效缓存 */
gitRouter.post('/fetch', async (req, res) => {
  respond(res, await write(req, (path) => ops.fetchBranches(path)));
});

gitRouter.post('/checkout', async (req, res) => {
  respond(
    res,
    await write(req, (path, body) => ops.checkoutBranch(path, requireText(body, 'branch'))),
  );
});

gitRouter.post('/checkout-remote', async (req, res) => {
  respond(
    res,
    await write(req, (path, body) => ops.checkoutRemoteBranch(path, requireText(body, 'remoteRef'))),
  );
});

gitRouter.post('/pull', async (req, res) => {
  respond(res, await write(req, (path) => ops.pullCurrent(path)));
});

gitRouter.post('/push', async (req, res) => {
  respond(res, await write(req, (path) => ops.pushCurrent(path)));
});

gitRouter.post('/push-remote', async (req, res) => {
  respond(
    res,
    await write(req, (path, body) => ops.pushBranchToRemote(path, requireText(body, 'branch'))),
  );
});

gitRouter.post('/restore', async (req, res) => {
  respond(
    res,
    await write(req, (path, body) => ops.restoreFiles(path, stringArray(body, 'files'))),
  );
});

/** 批量删除本地分支；部分成功也返回 200，失败明细在 data.failed 里 */
gitRouter.post('/branches/delete', async (req, res) => {
  respond(
    res,
    await write(req, (path, body) => ops.deleteBranches(path, stringArray(body, 'branches'))),
  );
});

gitRouter.post('/remote-branches/delete', async (req, res) => {
  respond(
    res,
    await write(req, (path, body) =>
      ops.deleteRemoteBranches(path, stringArray(body, 'remoteRefs')),
    ),
  );
});

// ---- 内部工具 ----

/** 写操作统一包装：反查路径 → 执行 → 失效扫描缓存 */
async function write<T>(
  req: Request,
  run: (absPath: string, body: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const data = await run(await repoPath(req), requestBody(req));
  invalidateReposCache();
  return data;
}

/** 由 localId 反查仓库绝对路径；查不到直接 404，不接受前端传路径 */
async function repoPath(req: Request): Promise<string> {
  const raw: unknown = req.params.localId;
  const localId = typeof raw === 'string' ? raw : '';
  const absPath = await resolveRepoPath(localId);
  if (absPath === null) throw new GitOpError(404, `未找到该仓库：${localId}`);
  return absPath;
}

function requestBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function requireText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GitOpError(400, `缺少参数 ${key}`);
  }
  return value.trim();
}

/** 字符串数组入参：非字符串项静默丢弃，空数组交由业务层报 400（提示更贴合语境） */
function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
}

function queryText(req: Request, key: string): string {
  const value = req.query[key];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
  return '';
}

function toInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
