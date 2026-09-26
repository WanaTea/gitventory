import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * 展开 `~` / `~/x` 为绝对路径。
 *
 * 扫描根有两个来源——环境变量与界面输入——两处都允许用户写 `~`，故收在这一份实现里。
 */
export function expandHome(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/')) return join(homedir(), target.slice(2));
  return target;
}

/**
 * 是否是绝对路径（`~` 开头视为绝对）。
 * 用于挡掉界面输入的相对路径：相对路径会被解析成「服务进程的工作目录」，
 * 结果取决于服务从哪里启动 —— 这种不确定性不该让用户去猜。
 */
export function isAbsolutePath(target: string): boolean {
  return isAbsolute(expandHome(target));
}
