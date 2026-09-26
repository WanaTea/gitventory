import { basename } from 'node:path';
import { config } from '../config/index.ts';
import { gitBranchRefs, gitLocalOnlyCommits, gitRemotes, gitStatus } from '../git/git.service.ts';

export type StatusInfo = {
  head: string;
  ahead: number;
  behind: number;
  changedCount: number;
  untrackedCount: number;
};

export type BranchRef = {
  name: string;
  lastCommitAt: string;
  upstreamTrack: string;
};

export type RawRemote = {
  name: string;
  url: string;
};

/**
 * 采集上下文（09 §5 采集与计算分离）：每仓库一次性产出只读对象，
 * 后续分类 / 状态计算全部为纯函数、无 IO。
 */
export type RepoContext = {
  absPath: string;
  name: string;
  remotes: RawRemote[];
  status: StatusInfo;
  branchCount: number;
  currentBranchLastCommitAt: string | null;
  unpushedBranches: string[];
  localOnlyCommits: number | null;
  errors: string[];
};

// ---- 解析（纯函数，无 IO）----

/** 解析 git status --porcelain=v2 --branch */
export function parseStatusPorcelainV2(stdout: string): StatusInfo {
  let head = '';
  let ahead = 0;
  let behind = 0;
  let changedCount = 0;
  let untrackedCount = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      // detached 时输出 "(detached)"，视为无当前分支名
      head = name.startsWith('(') ? '' : name;
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m !== null) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('#') || line.trim() === '') {
      continue;
    } else if (line.startsWith('?')) {
      untrackedCount++;
    } else if (!line.startsWith('!')) {
      // 1/2/u 开头（修改/重命名/冲突）均计为 tracked changes；! 为 ignored，跳过
      changedCount++;
    }
  }
  return { head, ahead, behind, changedCount, untrackedCount };
}

/** 解析 git for-each-ref 输出：name|date|track */
export function parseBranchRefs(stdout: string): BranchRef[] {
  const refs: BranchRef[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [name, date, ...rest] = line.split('|');
    if (name === undefined || name.trim() === '') continue;
    refs.push({
      name,
      lastCommitAt: date ?? '',
      upstreamTrack: rest.join('|'),
    });
  }
  return refs;
}

/** 解析 git remote -v：按 remote 名去重，fetch 优先于 push */
export function parseRemotes(stdout: string): RawRemote[] {
  const byName = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    // git remote -v 行尾为 "(fetch)" / "(push)"，括号是字面字符
    const m = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (m === null) continue;
    const name = m[1] ?? '';
    const url = m[2] ?? '';
    if (m[3] === 'push') {
      if (!byName.has(name)) byName.set(name, url);
    } else {
      byName.set(name, url);
    }
  }
  return [...byName.entries()].map(([name, url]) => ({ name, url }));
}

export function parseCommitCount(stdout: string): number | null {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ---- 采集（IO）----

/** 单仓库采集：4 条 git 命令并发执行，单项失败记入 errors[]，不中断 */
export async function inspectRepo(absPath: string): Promise<RepoContext> {
  const errors: string[] = [];
  const [statusRes, refsRes, countRes, remotesRes] = await Promise.allSettled([
    gitStatus(absPath),
    gitBranchRefs(absPath),
    gitLocalOnlyCommits(absPath),
    gitRemotes(absPath),
  ]);

  const status: StatusInfo =
    statusRes.status === 'fulfilled'
      ? parseStatusPorcelainV2(statusRes.value)
      : { head: '', ahead: 0, behind: 0, changedCount: 0, untrackedCount: 0 };
  if (statusRes.status === 'rejected') errors.push(`status: ${errorMessage(statusRes.reason)}`);

  let branchCount = 0;
  let currentBranchLastCommitAt: string | null = null;
  let unpushedBranches: string[] = [];
  if (refsRes.status === 'fulfilled') {
    const refs = parseBranchRefs(refsRes.value);
    branchCount = refs.length;
    const current = status.head === '' ? undefined : refs.find((r) => r.name === status.head);
    currentBranchLastCommitAt = current?.lastCommitAt ?? null;
    // 任一分支 upstream track 含 "ahead" 即视为该分支有未推送提交
    unpushedBranches = refs.filter((r) => r.upstreamTrack.includes('ahead')).map((r) => r.name);
  } else {
    errors.push(`for-each-ref: ${errorMessage(refsRes.reason)}`);
  }

  let localOnlyCommits: number | null = null;
  if (countRes.status === 'fulfilled') {
    localOnlyCommits = parseCommitCount(countRes.value);
  } else {
    errors.push(`rev-list: ${errorMessage(countRes.reason)}`);
  }

  let remotes: RawRemote[] = [];
  if (remotesRes.status === 'fulfilled') {
    remotes = parseRemotes(remotesRes.value);
  } else {
    errors.push(`remote: ${errorMessage(remotesRes.reason)}`);
  }

  return {
    absPath,
    name: basename(absPath),
    remotes,
    status,
    branchCount,
    currentBranchLastCommitAt,
    unpushedBranches,
    localOnlyCommits,
    errors,
  };
}

/** 批量采集（并发池），单仓库失败不影响整体 */
export async function inspectAll(absPaths: readonly string[]): Promise<RepoContext[]> {
  return mapWithConcurrency(absPaths, config.inspectConcurrency, inspectRepo);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await fn(items[index]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
