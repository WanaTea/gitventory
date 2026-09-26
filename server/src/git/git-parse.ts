import type { GitBranchRef, GitChange, GitCommit } from '../shared/git.ts';

/**
 * git 输出解析与入参校验：纯函数，无 IO（与 09 §5「采集与计算分离」同口径）。
 *
 * 两条硬约束：
 * 1. 前端传来的分支名与文件路径都必须先过校验 —— 虽然 execFile 用参数数组不会触发 shell 注入，
 *    但 `-x` 开头会被 git 当成选项、`../` 会逃出仓库，两者都必须挡在命令之前。
 * 2. 解析一律以「字段分隔符 + 定长字段」为准，不靠 `|` 之类可能出现在内容里的字符。
 */

/** git 用 ASCII Unit Separator 分隔字段（见 git.service.ts 的 FS 常量） */
const FS = '\u001f';

// ---- 入参校验 ----

/** git ref 禁用的可见符号：空格 ~ ^ : ? * [ \ （`[` 在字符类内即为字面量） */
const REF_FORBIDDEN_SYMBOLS = /[ ~^:?*[\\]/;

const UTF8_ENCODER = new TextEncoder();

/**
 * 单个路径段的**字节**上限。
 * ref 最终会落成 `.git/refs/heads/<name>` 下的文件路径，受文件系统 NAME_MAX（255 字节）约束；
 * 按字节而非字符数判断，否则 255 个汉字（765 字节）会被放行再撞 ENAMETOOLONG。
 * 注意这是 git 本身没有的额外限制（`git check-ref-format` 不查长度），属于"提前给出可读错误"。
 */
const MAX_REF_COMPONENT_BYTES = 255;

/**
 * 控制字符（< 0x20）与 DEL(0x7F) 也是 git ref 禁用字符。
 * 按码位判断而不写进正则：正则里出现控制字符会触发 no-control-regex。
 */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 分支/引用名校验：对齐 **git 自己的 ref 规则**（`git check-ref-format`），不再用 ASCII 白名单。
 *
 * 血泪教训：早期版本用 `^[A-Za-z0-9._/@+-]+$` 白名单，把中文分支名全部拒掉 ——
 * 而内网 GitLab 下 354 个分支引用里有 91 条含中文（11 个仓库受影响），
 * 表现为「切换/看提交/删除分支全部 400」。git 本身允许非 ASCII，白名单属于过度收紧。
 *
 * ⚠️ 不要试图用 `--` 终止选项解析来兜「以 - 开头」：实测 `git checkout -- <branch>` 会切到
 * **pathspec 模式**（报 `pathspec 'x' did not match`），`git log -- <ref>` 同理把引用当路径；
 * 只有 `git branch -d -- <name>` 才把 `--` 当分隔符。故此处直接拒绝 `-` 开头的名字。
 *
 * 与 check-ref-format 的对应关系（分支名 = refs/heads/ 下的一段路径）：
 * 非空 · 不以 `-` 开头（git branch 选项歧义）· 无控制字符/空格/`~^:?*[\` ·
 * 无 `..` / `@{` / `//` · 不以 `/` 开头或结尾 · 不以 `.` 结尾 · 每段非空、非 `.`/`..`、不以 `.lock` 结尾
 */
export function isSafeRef(value: string): boolean {
  if (value === '') return false;
  if (value.startsWith('-')) return false;
  if (hasControlChar(value) || REF_FORBIDDEN_SYMBOLS.test(value)) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  for (const part of value.split('/')) {
    if (part === '' || part === '.' || part === '..') return false;
    if (part.endsWith('.lock')) return false;
    if (UTF8_ENCODER.encode(part).length > MAX_REF_COMPONENT_BYTES) return false;
  }
  return true;
}

/** 仓库内相对路径校验（撤销改动用）：必须是仓库内相对路径，且不含回退段 */
export function isSafeRepoRelativePath(value: string): boolean {
  if (value === '' || value.length > 1024) return false;
  if (value.startsWith('/')) return false;
  if (value.startsWith('-')) return false;
  if (value.includes('\0')) return false;
  return !value.split('/').includes('..');
}

/** 远程引用 origin/xxx → { remote: 'origin', name: 'xxx' }；无斜杠时按 origin 兜底 */
export function splitRemoteRef(remoteRef: string): { remote: string; name: string } {
  const idx = remoteRef.indexOf('/');
  if (idx === -1) return { remote: 'origin', name: remoteRef };
  return { remote: remoteRef.slice(0, idx), name: remoteRef.slice(idx + 1) };
}

/** 远程引用对应的本地分支名（去掉 remote 前缀） */
export function remoteLocalName(remoteRef: string): string {
  return splitRemoteRef(remoteRef).name;
}

// ---- 解析 ----

/** for-each-ref refs/heads 输出 → 本地分支列表 */
export function parseBranchList(stdout: string): GitBranchRef[] {
  const refs: GitBranchRef[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [name, updatedAt] = line.split(FS);
    if (name === undefined || name === '' || /\/HEAD$/.test(name)) continue;
    refs.push({ name, updatedAt: updatedAt ?? '' });
  }
  return refs;
}

/**
 * for-each-ref refs/remotes 输出 → 远程分支列表。
 * 必须多挡一层：`refs/remotes/origin/HEAD` 是符号引用，`refname:short` 会退化成 `origin`
 * （没有 `/`，`\/HEAD$` 匹配不到），显示出来会是一条假分支；不同 git 版本的短名口径不一致，
 * 故「短名必须含 `/`」与「不以 /HEAD 结尾」两条同时生效 —— refs/remotes 下合法分支名必为 `remote/branch`。
 */
export function parseRemoteBranchList(stdout: string): GitBranchRef[] {
  return parseBranchList(stdout).filter(
    (ref) => ref.name.includes('/') && !/\/HEAD$/.test(ref.name),
  );
}

/**
 * git log 输出 → 提交页。
 * 服务端多取 1 条用于判断 hasMore，这里把多余那条裁掉。
 */
export function parseCommitPage(stdout: string, limit: number): { commits: GitCommit[]; hasMore: boolean } {
  const commits: GitCommit[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const first = line.indexOf(FS);
    if (first === -1) continue;
    const second = line.indexOf(FS, first + 1);
    if (second === -1) continue;
    commits.push({
      time: line.slice(0, first),
      author: line.slice(first + 1, second),
      // subject 允许含分隔符，取剩余全部
      subject: line.slice(second + 1),
    });
  }
  const hasMore = commits.length > limit;
  return { commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
}

/**
 * `git status --porcelain -z` → 已跟踪改动 + 未跟踪计数。
 *
 * -z 下重命名/复制占两个 NUL 字段：`XY 新路径\0旧路径\0`，
 * 解析时必须多消费一个字段，否则旧路径会被当成一条独立改动。
 */
export function parsePorcelainZ(stdout: string): { changes: GitChange[]; untrackedCount: number } {
  const parts = stdout.split('\0');
  const changes: GitChange[] = [];
  let untrackedCount = 0;
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i] ?? '';
    i++;
    if (entry === '' || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.startsWith('R') || code.startsWith('C')) {
      i++; // 跳过紧随其后的旧路径字段
    }
    if (code.startsWith('??')) {
      untrackedCount++;
      continue;
    }
    if (code.startsWith('!!')) continue; // ignored
    changes.push({ file, status: code.trim(), mtime: null });
  }
  return { changes, untrackedCount };
}

/** `git rev-list --left-right --count upstream...current` → { behind, ahead } */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const parts = stdout.trim().split(/\s+/);
  const behind = Number.parseInt(parts[0] ?? '', 10);
  const ahead = Number.parseInt(parts[1] ?? '', 10);
  return {
    behind: Number.isFinite(behind) ? behind : 0,
    ahead: Number.isFinite(ahead) ? ahead : 0,
  };
}

/**
 * 空仓库 / 引用不存在的报错属于「无提交」而非故障，
 * 这类良性失败按空列表返回，不弹错误。
 */
export function isBenignLogError(text: string): boolean {
  return /does not have any commits|unknown revision|bad revision|ambiguous argument|bad object/i.test(text);
}
