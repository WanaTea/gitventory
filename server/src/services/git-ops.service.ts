import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '../git/git.service.ts';
import {
  isBenignLogError,
  isSafeRef,
  isSafeRepoRelativePath,
  parseAheadBehind,
  parseBranchList,
  parseCommitPage,
  parsePorcelainZ,
  parseRemoteBranchList,
  remoteLocalName,
  splitRemoteRef,
} from '../git/git-parse.ts';
import {
  GIT_COMMIT_MAX_LIMIT,
  GIT_COMMIT_PAGE_SIZE,
  type GitBatchData,
  type GitBranchesData,
  type GitCommitsData,
  type GitOpData,
  type GitStatusData,
} from '../shared/git.ts';
import { pickGitError } from '../utils/exec-git.ts';
import { GitOpError } from '../utils/git-op-error.ts';
import { parseRemotes } from './inspect.service.ts';

/**
 * Git 分支弹窗的业务编排层。
 * 入参（分支名 / 引用 / 文件路径）全部来自前端，进命令前一律校验；
 * 批量删除串行执行 —— 同一仓库并发写会撞 index.lock。
 */

// ---- 只读 ----

/** 当前分支 + 本地/远程分支 + origin 地址（弹窗首屏） */
export async function readBranches(absPath: string): Promise<GitBranchesData> {
  const [currentRes, localRes, remoteRes, remotesRes] = await Promise.all([
    git.gitCurrentBranch(absPath),
    git.gitLocalBranches(absPath),
    git.gitRemoteBranches(absPath),
    // 无 remote 不是错误：git remote -v 输出为空即视为未接入
    git.gitRemotes(absPath).catch(() => ''),
  ]);
  if (!localRes.ok) throw new GitOpError(409, pickGitError(localRes, '读取本地分支失败'));
  if (!remoteRes.ok) throw new GitOpError(409, pickGitError(remoteRes, '读取远程分支失败'));
  return {
    current: currentRes.ok ? currentRes.stdout.trim() : '',
    remoteUrl: pickRemoteUrl(remotesRes),
    local: parseBranchList(localRes.stdout),
    remote: parseRemoteBranchList(remoteRes.stdout),
  };
}

/**
 * 拉取远程引用后返回最新分支列表。
 * fetch 失败（无 remote / 网络不通 / 无凭据）不阻断：本地已有引用照样可用，
 * 但必须把降级原因带回去，否则用户会以为「已同步」。
 */
export async function fetchBranches(absPath: string): Promise<GitBranchesData> {
  const result = await git.gitFetchPrune(absPath);
  const data = await readBranches(absPath);
  if (!result.ok) {
    return { ...data, warning: `拉取远程失败，当前显示的是本地已有引用：${pickGitError(result, '未知原因')}` };
  }
  return data;
}

/** 工作区状态：分支、已跟踪改动明细（含 mtime）、未跟踪数、ahead/behind */
export async function readStatus(absPath: string): Promise<GitStatusData> {
  const currentRes = await git.gitCurrentBranch(absPath);
  const current = currentRes.ok ? currentRes.stdout.trim() : '';

  const statusRes = await git.gitStatusPorcelainZ(absPath);
  if (!statusRes.ok) throw new GitOpError(409, pickGitError(statusRes, '读取工作区状态失败'));
  const parsed = parsePorcelainZ(statusRes.stdout);
  const changes = parsed.changes.map((change) => ({
    ...change,
    mtime: fileMtime(absPath, change.file),
  }));

  const upstreamRes = await git.gitUpstreamRef(absPath);
  const upstream = upstreamRes.ok ? upstreamRes.stdout.trim() : '';

  let ahead = 0;
  let behind = 0;
  if (upstream !== '' && current !== '') {
    const ab = await git.gitAheadBehind(absPath, upstream, current);
    if (ab.ok) ({ ahead, behind } = parseAheadBehind(ab.stdout));
  }

  return {
    current,
    // 「有改动」只统计已跟踪文件：未跟踪文件单独计数，与清单页口径一致
    hasChanges: changes.length > 0,
    changedCount: changes.length,
    untrackedCount: parsed.untrackedCount,
    changes,
    ahead,
    behind,
    upstream,
  };
}

/** 分页读某分支的提交记录（前端展开分支时才调用） */
export async function readCommits(
  absPath: string,
  ref: string,
  skip: number,
  limit: number,
): Promise<GitCommitsData> {
  assertRef(ref);
  const safeSkip = Number.isFinite(skip) && skip > 0 ? Math.floor(skip) : 0;
  const safeLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), GIT_COMMIT_MAX_LIMIT)
      : GIT_COMMIT_PAGE_SIZE;

  const result = await git.gitBranchLog(absPath, ref, safeSkip, safeLimit);
  if (!result.ok) {
    // 空仓库 / 引用不存在属于「无提交」，按空页返回而不是报错
    if (isBenignLogError(`${result.stderr}\n${result.stdout}`)) {
      return { ref, skip: safeSkip, commits: [], hasMore: false };
    }
    throw new GitOpError(409, pickGitError(result, '读取提交失败'));
  }
  const page = parseCommitPage(result.stdout, safeLimit);
  return { ref, skip: safeSkip, commits: page.commits, hasMore: page.hasMore };
}

// ---- 写操作 ----

/** 切换到本地分支 */
export async function checkoutBranch(absPath: string, branch: string): Promise<GitOpData> {
  assertRef(branch);
  const result = await git.gitCheckout(absPath, branch);
  if (!result.ok) throw new GitOpError(409, pickGitError(result, '切换分支失败'));
  return { branch };
}

/** 从远程分支签出到同名本地分支（本地已存在时 git 会报错，由前端提示） */
export async function checkoutRemoteBranch(absPath: string, remoteRef: string): Promise<GitOpData> {
  assertRef(remoteRef);
  const localName = remoteLocalName(remoteRef);
  assertRef(localName);
  const result = await git.gitCheckoutNewFromRemote(absPath, localName, remoteRef);
  if (!result.ok) throw new GitOpError(409, pickGitError(result, '签出失败'));
  return { branch: localName, remoteRef };
}

/** 拉取当前分支并 rebase（冲突时不强制，把 git 的原因原样返回） */
export async function pullCurrent(absPath: string): Promise<GitOpData> {
  const result = await git.gitPullRebase(absPath);
  if (!result.ok) throw new GitOpError(409, pickGitError(result, '拉取失败'));
  return { output: result.stdout.trim() };
}

/** 推送当前分支 */
export async function pushCurrent(absPath: string): Promise<GitOpData> {
  const result = await git.gitPushCurrent(absPath);
  if (!result.ok) throw new GitOpError(409, pickGitError(result, '推送失败'));
  return { output: result.stdout.trim() };
}

/** 推送指定分支到 origin 并建立上游 */
export async function pushBranchToRemote(absPath: string, branch: string): Promise<GitOpData> {
  assertRef(branch);
  const result = await git.gitPushSetUpstream(absPath, branch);
  if (!result.ok) throw new GitOpError(409, pickGitError(result, '推送失败'));
  return { branch };
}

/** 撤销选中的已跟踪文件改动（不动未跟踪文件） */
export async function restoreFiles(absPath: string, files: readonly string[]): Promise<GitOpData> {
  if (files.length === 0) throw new GitOpError(400, '没有选择要撤销的文件');
  for (const file of files) {
    if (!isSafeRepoRelativePath(file)) throw new GitOpError(400, `文件路径非法：${file}`);
  }
  const result = await git.gitRestoreFiles(absPath, files);
  if (!result.ok) throw new GitOpError(409, pickGitError(result, '撤销失败'));
  return { restored: files.length };
}

/** 批量删除本地分支：串行执行，逐条汇总（-d 只删已合并分支，不做 -D 强删） */
export async function deleteBranches(absPath: string, branches: readonly string[]): Promise<GitBatchData> {
  const list = normalizeRefList(branches, '没有选择要删除的分支');
  const results = await runSequential(list, async (branch) => {
    const result = await git.gitDeleteBranch(absPath, branch);
    return result.ok
      ? { name: branch, ok: true as const }
      : { name: branch, ok: false as const, error: pickGitError(result, '删除失败') };
  });
  return summarizeBatch(results);
}

/** 批量删除远程分支：push <remote> --delete，成功后尽力清理本地追踪引用 */
export async function deleteRemoteBranches(
  absPath: string,
  remoteRefs: readonly string[],
): Promise<GitBatchData> {
  const list = normalizeRefList(remoteRefs, '没有选择要删除的远程分支');
  const results = await runSequential(list, async (remoteRef) => {
    const { remote, name } = splitRemoteRef(remoteRef);
    if (remote === '' || name === '') {
      return { name: remoteRef, ok: false as const, error: '远程引用格式不正确' };
    }
    const result = await git.gitDeleteRemoteBranch(absPath, remote, name);
    if (!result.ok) {
      return { name: remoteRef, ok: false as const, error: pickGitError(result, '删除失败') };
    }
    // 追踪引用可能已被 git 自动删除，失败不影响本次结果
    await git.gitDeleteRemoteTrackingRef(absPath, remoteRef);
    return { name: remoteRef, ok: true as const };
  });
  return summarizeBatch(results);
}

// ---- 内部工具 ----

function assertRef(value: string): void {
  if (!isSafeRef(value)) throw new GitOpError(400, `分支名非法：${value}`);
}

/** 去重 + 校验 + 非空校验；空列表直接报 400，避免白跑一趟 git */
function normalizeRefList(values: readonly string[], emptyMessage: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const value of values) {
    assertRef(value);
    if (seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }
  if (list.length === 0) throw new GitOpError(400, emptyMessage);
  return list;
}

/** 串行执行：同一仓库并发写会撞 .git/index.lock */
async function runSequential<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await worker(item));
  }
  return results;
}

type BatchItemResult = { name: string; ok: true } | { name: string; ok: false; error: string };

/** 部分成功不整体失败：deleted / failed 同时返回，由前端决定提示语气 */
function summarizeBatch(results: readonly BatchItemResult[]): GitBatchData {
  const deleted: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const item of results) {
    if (item.ok) deleted.push(item.name);
    else failed.push({ name: item.name, error: item.error });
  }
  return { deleted, failed, total: results.length };
}

/** 文件 mtime：stat 失败（文件已被删/权限不足）不影响状态展示，置 null */
function fileMtime(absPath: string, file: string): string | null {
  if (!isSafeRepoRelativePath(file)) return null;
  try {
    return new Date(statSync(join(absPath, file)).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/** origin 优先，其次第一条 remote */
function pickRemoteUrl(remoteOutput: string): string {
  const remotes = parseRemotes(remoteOutput);
  return remotes.find((item) => item.name === 'origin')?.url ?? remotes[0]?.url ?? '';
}
