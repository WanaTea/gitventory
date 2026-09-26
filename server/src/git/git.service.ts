import { config } from '../config/index.ts';
import { execGit, execGitResult, type GitRunResult } from '../utils/exec-git.ts';

/**
 * git 命令层：只做「拼参数 + 执行」，不做解析、不做校验、不做聚合。
 * 解析 → git/git-parse.ts 的纯函数；编排与入参校验 → services/git-ops.service.ts。
 *
 * 字段分隔符统一用 ASCII Unit Separator（0x1F）而不是 `|`：
 * ref 名与 commit subject 都允许出现 `|`，用 `|` 分隔会被内容污染。
 *
 * ⚠️ 两个转义口径不能混：
 * - `git log --format` 属于 pretty-format，认识 `%x1f` 转义；
 * - `git for-each-ref --format` 不认识 `%xNN`，必须直接把 0x1F 字节写进参数
 *   （参数走 execFile 数组，无 shell，控制字符不会被再解释）。
 */
const FS_PRETTY = '%x1f';
const FS_CHAR = '\u001f';

// ---- 只读命令（进扫描流水线，失败即抛错）----

/** git status --porcelain=v2 --branch（分支/dirty/ahead/behind 的唯一来源） */
export function gitStatus(cwd: string): Promise<string> {
  return execGit(['status', '--porcelain=v2', '--branch'], { cwd, timeoutMs: config.gitTimeoutMs });
}

/** git for-each-ref：本地分支 + 最后提交时间 + upstream 跟踪状态 */
export function gitBranchRefs(cwd: string): Promise<string> {
  return execGit(
    ['for-each-ref', '--format=%(refname:short)|%(committerdate:iso8601-strict)|%(upstream:track)', 'refs/heads'],
    { cwd, timeoutMs: config.gitTimeoutMs },
  );
}

/** git rev-list：本地独有提交数（N2「从未 push」判定依据） */
export function gitLocalOnlyCommits(cwd: string): Promise<string> {
  return execGit(['rev-list', '--count', '--branches', '--not', '--remotes'], {
    cwd,
    timeoutMs: config.gitTimeoutMs,
  });
}

/** git remote -v */
export function gitRemotes(cwd: string): Promise<string> {
  return execGit(['remote', '-v'], { cwd, timeoutMs: config.gitTimeoutMs });
}

// ---- 分支弹窗：只读命令 ----

/** git branch --show-current；detached HEAD 时输出为空 */
export function gitCurrentBranch(cwd: string): Promise<GitRunResult> {
  return execGitResult(['branch', '--show-current'], { cwd, timeoutMs: config.gitTimeoutMs });
}

/** 本地分支 + 最后提交时间，按提交时间倒序 */
export function gitLocalBranches(cwd: string): Promise<GitRunResult> {
  return execGitResult(
    ['for-each-ref', '--sort=-committerdate', branchFormat(), 'refs/heads'],
    { cwd, timeoutMs: config.gitTimeoutMs },
  );
}

/** 远程分支 + 最后提交时间，按提交时间倒序 */
export function gitRemoteBranches(cwd: string): Promise<GitRunResult> {
  return execGitResult(
    ['for-each-ref', '--sort=-committerdate', branchFormat(), 'refs/remotes'],
    { cwd, timeoutMs: config.gitTimeoutMs },
  );
}

/** branchFormat 名在前、时间在后；时间字段（ISO）不含分隔符，故取第一个分隔符切开即可 */
function branchFormat(): string {
  return `--format=%(refname:short)${FS_CHAR}%(committerdate:iso8601-strict)`;
}

/**
 * 分页读某 ref 的提交；多取 1 条用于判断 hasMore，
 * 避免为了「还有没有下一页」再跑一次 rev-list 计数。
 */
export function gitBranchLog(cwd: string, ref: string, skip: number, limit: number): Promise<GitRunResult> {
  return execGitResult(
    ['log', `--skip=${skip}`, '-n', String(limit + 1), `--format=%cI${FS_PRETTY}%an${FS_PRETTY}%s`, ref],
    { cwd, timeoutMs: config.gitTimeoutMs },
  );
}

/** 工作区改动（-z 模式：文件名含空格/中文时 git 会加引号，-z 不会） */
export function gitStatusPorcelainZ(cwd: string): Promise<GitRunResult> {
  return execGitResult(['status', '--porcelain', '-z'], { cwd, timeoutMs: config.gitTimeoutMs });
}

/** 上游分支全名，如 origin/main；无上游时 git 报错（由调用方视为「无上游」） */
export function gitUpstreamRef(cwd: string): Promise<GitRunResult> {
  return execGitResult(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    cwd,
    timeoutMs: config.gitTimeoutMs,
  });
}

/** ahead/behind：left=仅上游有(behind)，right=仅本地有(ahead) */
export function gitAheadBehind(cwd: string, upstream: string, current: string): Promise<GitRunResult> {
  return execGitResult(['rev-list', '--left-right', '--count', `${upstream}...${current}`], {
    cwd,
    timeoutMs: config.gitTimeoutMs,
  });
}

// ---- 写操作（一律走 execGitResult，保留 stderr 供错误提示）----

/** 切换本地分支（标准切换，不做强制） */
export function gitCheckout(cwd: string, branch: string): Promise<GitRunResult> {
  return execGitResult(['checkout', branch], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 从远程分支签出到本地新分支 */
export function gitCheckoutNewFromRemote(
  cwd: string,
  localName: string,
  remoteRef: string,
): Promise<GitRunResult> {
  return execGitResult(['checkout', '-b', localName, remoteRef], {
    cwd,
    timeoutMs: config.gitWriteTimeoutMs,
  });
}

/** 拉取远程分支引用并清理已删除的远端分支（--prune） */
export function gitFetchPrune(cwd: string): Promise<GitRunResult> {
  return execGitResult(['fetch', '--prune'], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 拉取当前分支（--rebase，冲突时不强制） */
export function gitPullRebase(cwd: string): Promise<GitRunResult> {
  return execGitResult(['pull', '--rebase'], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 推送当前分支 */
export function gitPushCurrent(cwd: string): Promise<GitRunResult> {
  return execGitResult(['push'], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 推送指定分支到 origin 并建立上游（无上游则创建远程分支） */
export function gitPushSetUpstream(cwd: string, branch: string): Promise<GitRunResult> {
  return execGitResult(['push', '-u', 'origin', branch], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 删除本地分支：-d 只删已合并分支，未合并会失败（不做 -D 强删） */
export function gitDeleteBranch(cwd: string, branch: string): Promise<GitRunResult> {
  return execGitResult(['branch', '-d', branch], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 删除远程分支：git push <remote> --delete <name> */
export function gitDeleteRemoteBranch(cwd: string, remote: string, name: string): Promise<GitRunResult> {
  return execGitResult(['push', remote, '--delete', name], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 清理已被远程删除的本地追踪引用（尽力而为，失败不影响主结果） */
export function gitDeleteRemoteTrackingRef(cwd: string, remoteRef: string): Promise<GitRunResult> {
  return execGitResult(['branch', '-dr', remoteRef], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}

/** 撤销已跟踪文件的改动到最近一次提交（不动未跟踪文件） */
export function gitRestoreFiles(cwd: string, files: readonly string[]): Promise<GitRunResult> {
  return execGitResult(['restore', '--', ...files], { cwd, timeoutMs: config.gitWriteTimeoutMs });
}
