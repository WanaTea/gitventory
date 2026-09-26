import type { PlatformType } from './platform.ts';

export type UnlinkedReason = 'N1' | 'N2';

export type LinkStatus = 'linked' | 'unlinked';

// ---- 查询过滤字典（02 §6.1；前端可镜像同一组字面量）----

/** link 过滤值：linked / unlinked 按状态，N1~N4 按 reasons 命中（N3/N4 为 P2 预留） */
export const LINK_FILTERS = ['linked', 'unlinked', 'N1', 'N2', 'N3', 'N4'] as const;

export type LinkFilter = (typeof LINK_FILTERS)[number];

export const STATUS_FILTERS = ['dirty', 'ahead', 'stale'] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const REPO_SORTS = ['lastActivity', 'name', 'path'] as const;

export type RepoSort = (typeof REPO_SORTS)[number];

/** 已解析的查询条件：同参数内多值为 OR，参数之间为 AND；缺省即不筛选 */
export type ReposQuery = {
  q?: string;
  platforms?: PlatformType[];
  links?: LinkFilter[];
  statuses?: StatusFilter[];
  sort?: RepoSort;
};

export type RemoteInfo = {
  name: string;
  url: string;
  host: string;
  fullPath: string;
};

export type RepoPlatform = {
  type: PlatformType;
  label: string;
  host: string;
};

export type RepoLink = {
  status: LinkStatus;
  reasons: UnlinkedReason[];
};

export type RepoStatus = {
  currentBranch: string;
  dirty: boolean;
  changedCount: number;
  untrackedCount: number;
  ahead: number;
  behind: number;
  unpushedBranches: string[];
  localOnlyCommits: number;
  lastCommitAt: string | null;
  /** 长期未动：lastCommitAt 早于 now - staleDays；无时间时恒为 false */
  stale: boolean;
};

export type Repo = {
  localId: string;
  name: string;
  path: string;
  absPath: string;
  platform: RepoPlatform;
  remotes: RemoteInfo[];
  link: RepoLink;
  status: RepoStatus;
  branchCount: number;
  errors: string[];
};

export type ReposSummary = {
  total: number;
  linked: number;
  unlinked: number;
  dirty: number;
  aheadCurrentBranch: number;
  unpushedAnyBranch: number;
  stale: number;
  byPlatform: Partial<Record<PlatformType, number>>;
  byUnlinkedReason: Partial<Record<UnlinkedReason, number>>;
};

export type ReposData = {
  scannedAt: string;
  roots: string[];
  summary: ReposSummary;
  items: Repo[];
  warnings: string[];
};

// ---- 本地打开动作（POST /api/repos/:localId/open）----
//
// 「打开目标」不再是编译期常量：内置一套常见应用，使用者可用 config/open-targets.json
// 覆盖或扩充（见 open-targets.service.ts）。因此前端**只消费 /api/health.openTargets**
// —— 顺序、展示名、可用性、不可用原因全由服务端下发，用户加自己的 IDE 时前端不用改代码。

/** 打开目标的当前状态；数组顺序即按钮顺序 */
export type OpenTargetInfo = {
  id: string;
  label: string;
  available: boolean;
  /** 不可用原因（服务端已按平台措辞），前端直接展示，不再自己猜 */
  reason?: string;
};

export type OpenRepoResult = {
  opened: string;
  path: string;
};
