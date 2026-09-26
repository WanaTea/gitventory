/**
 * git 错误文案中文化。
 *
 * 存在的理由：git 的输出是英文，而它**直接就是**用户看到的提示
 * （`pickGitError` 挑出的那一行会一路透到前端 el-alert / toast）。
 * 只做「常见且用户能自助处理」的映射，未命中的**原样返回**——宁可显示英文原文，也不丢信息。
 *
 * 规则按「从具体到宽泛」排列，先命中先返回：
 * 越窄的模式（带具体路径/分支名的）必须排在越宽的兜底模式之前。
 */

interface GitErrorRule {
  pattern: RegExp;
  message: (match: RegExpMatchArray) => string;
}

/** 未安装 git 时给用户的唯一一句话（多处复用：接口告警、错误文案、启动预检） */
export const GIT_MISSING_MESSAGE = '未检测到 git 命令：请先安装 git 并确保它在 PATH 中';

const GIT_ERROR_RULES: GitErrorRule[] = [
  // ── 运行环境 ───────────────────────────────────────────
  {
    // child_process 起不来进程时的原文（`spawn git ENOENT`），按大小写不敏感匹配
    pattern: /spawn git ENOENT/i,
    message: () => GIT_MISSING_MESSAGE,
  },

  // ── 推送 / 上游 ────────────────────────────────────────
  {
    pattern: /^fatal: No configured push destination/i,
    message: () => '该仓库没有配置远程地址（remote），无法推送',
  },
  {
    pattern: /^fatal: The current branch (.+) has no upstream branch/i,
    message: (m) => `分支 ${m[1]} 没有上游分支，无法推送（用「推送」按钮可自动建立上游）`,
  },
  {
    pattern: /^fatal: The upstream branch of your current branch does not match/i,
    message: () => '当前分支与上游分支不匹配（改过名或远程已删），请重新建立上游',
  },
  {
    pattern: /^fatal: You are not currently on a branch/i,
    message: () => '当前处于游离 HEAD 状态，无法执行该操作，请先切换到一个分支',
  },
  {
    // 注意：这条 git 输出**没有** fatal:/error: 前缀，靠 pickGitError 的「第一条非 hint」兜底选中
    pattern: /^There is no tracking information for the current branch/i,
    message: () => '当前分支没有上游分支，无法拉取（先推送一次建立上游）',
  },
  {
    pattern: /^error: failed to push some refs/i,
    message: () => '推送被拒绝：远程有本地没有的提交，请先拉取再推送',
  },

  // ── 远程可达性 / 认证 ──────────────────────────────────
  {
    pattern: /^fatal: '(.+?)' does not appear to be a git repository/i,
    message: (m) => `远程地址不是有效的 git 仓库：${m[1]}`,
  },
  {
    pattern: /^fatal: repository '(.+?)' not found/i,
    message: (m) => `远程仓库不存在或无访问权限：${m[1]}`,
  },
  {
    pattern: /^fatal: Authentication failed/i,
    message: () => '远程认证失败：账号或凭据无效',
  },
  {
    pattern: /^fatal: could not read Username for '(.+?)'/i,
    message: (m) => `远程需要登录但无法交互输入（${m[1]}），请先在终端完成一次认证`,
  },
  {
    pattern: /^fatal: unable to access '(.+?)': Could not resolve host/i,
    message: (m) => `无法解析远程主机（${m[1]}），请检查网络或代理`,
  },
  {
    pattern: /^fatal: unable to access '(.+?)'/i,
    message: (m) => `无法访问远程仓库：${m[1]}`,
  },
  {
    pattern: /^fatal: could not read from remote repository/i,
    message: () => '无法读取远程仓库，请检查网络、权限与仓库地址',
  },

  // ── 本地改动 / 冲突 ────────────────────────────────────
  {
    pattern: /^error: Your local changes to the following files would be overwritten by (checkout|merge)/i,
    message: (m) => `本地有未提交的改动会被${m[1].toLowerCase() === 'checkout' ? '切换分支' : '合并'}覆盖，请先提交或撤销改动`,
  },
  {
    pattern: /^error: cannot (?:pull|merge|rebase)[^\n]*: (?:You have unstaged changes|Your index contains uncommitted changes)/i,
    message: () => '本地有未提交的改动，无法完成本次操作，请先提交或暂存',
  },
  {
    pattern: /^CONFLICT \(.+?\): .*conflict in (.+)$/i,
    message: (m) => `合并冲突：${m[1]}，请先手动解决冲突再继续`,
  },
  {
    pattern: /^error: could not apply (.+?)\.\.\./i,
    message: () => 'rebase 过程中出现冲突，请解决冲突后执行 git rebase --continue',
  },
  {
    pattern: /^error: you need to resolve your current index first/i,
    message: () => '存在未解决的冲突，需先解决并提交后再继续',
  },
  {
    pattern: /^fatal: refusing to merge unrelated histories/i,
    message: () => '两个仓库没有共同历史，git 拒绝合并',
  },

  // ── 分支 / 引用 ────────────────────────────────────────
  {
    pattern: /^error: the branch '(.+?)' is not fully merged/i,
    message: (m) => `分支 ${m[1]} 还有未合入当前分支的提交，为防丢失代码已拒绝删除`,
  },
  {
    pattern: /^error: branch '(.+?)' not found/i,
    message: (m) => `分支 ${m[1]} 不存在（可能已被删除或改名）`,
  },
  {
    pattern: /^fatal: a branch named '(.+?)' already exists/i,
    message: (m) => `本地已存在同名分支 ${m[1]}，无需从远程签出`,
  },
  {
    pattern: /^error: pathspec '(.+?)' did not match/i,
    message: (m) => `引用 ${m[1]} 无法解析（分支可能不存在）`,
  },
  {
    pattern: /^fatal: (?:bad revision|ambiguous argument) '(.+?)'/i,
    message: (m) => `引用 ${m[1]} 无法解析（分支可能不存在）`,
  },

  // ── 环境 / 仓库状态 ────────────────────────────────────
  {
    pattern: /^fatal: not a git repository/i,
    message: () => '该目录不是 git 仓库（.git 已被删除或移动）',
  },
  {
    pattern: /Unable to create '(.+?)index\.lock'/i,
    message: () => 'git 索引被占用（index.lock 已存在），可能有另一个 git 进程正在运行，稍后重试',
  },
  {
    pattern: /unable to auto-detect email address/i,
    message: () => '未配置提交身份（缺少 user.name / user.email）',
  },
];

/** 把一行 git 输出翻成中文；未命中任何规则时**原样返回**（不丢原文，便于排查） */
export function translateGitError(line: string): string {
  for (const rule of GIT_ERROR_RULES) {
    const match = rule.pattern.exec(line);
    if (match !== null) return rule.message(match);
  }
  return line;
}
