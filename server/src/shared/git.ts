// Git 分支弹窗的接口契约（POST/GET /api/repos/:localId/*）
//
// 约定：
// - 路径一律由服务端按 localId 反查，前端不传任何目录字符串；
// - 时间统一 ISO 字符串（与 Repo.status.lastCommitAt 同口径），前端复用 utils/format 格式化；
// - 批量操作不因个别失败整体失败：data 里同时给 deleted / failed，由前端决定提示语气。

/** 分支引用：name 为短名（本地）或 remote/短名（远程），updatedAt 为该分支最后提交时间 */
export type GitBranchRef = {
  name: string;
  updatedAt: string;
};

/** GET /api/repos/:localId/branches、POST /api/repos/:localId/fetch */
export type GitBranchesData = {
  /** 当前分支；detached HEAD 时为空串 */
  current: string;
  /** origin 优先，取不到则第一条 remote */
  remoteUrl: string;
  local: GitBranchRef[];
  remote: GitBranchRef[];
  /** 降级说明：如 fetch 失败（无 remote / 网络不通）但本地引用仍可用 */
  warning?: string;
};

export type GitCommit = {
  author: string;
  time: string;
  subject: string;
};

/** GET /api/repos/:localId/commits */
export type GitCommitsData = {
  ref: string;
  skip: number;
  commits: GitCommit[];
  hasMore: boolean;
};

/** 工作区单条改动；status 为 porcelain 两位状态码去空格后的短码（M/A/D/R/?? 除外） */
export type GitChange = {
  file: string;
  status: string;
  /** 文件 mtime；stat 失败时为 null */
  mtime: string | null;
};

/** GET /api/repos/:localId/status */
export type GitStatusData = {
  current: string;
  hasChanges: boolean;
  changedCount: number;
  untrackedCount: number;
  changes: GitChange[];
  ahead: number;
  behind: number;
  /** 上游分支全名，如 origin/main；无上游为空串 */
  upstream: string;
};

/** 批量删除结果：deleted 与 failed 互补，total = 两者之和 */
export type GitBatchData = {
  deleted: string[];
  failed: { name: string; error: string }[];
  total: number;
};

/** 单个写操作的执行结果（附带 git 的原始输出，供前端可选展示） */
export type GitOpData = {
  /** 供前端做「切到哪个分支了」这类回显 */
  branch?: string;
  remoteRef?: string;
  restored?: number;
  output?: string;
};

export const GIT_COMMIT_PAGE_SIZE = 30;
/** 单页上限兜底，避免一次拉爆 git log */
export const GIT_COMMIT_MAX_LIMIT = 200;
