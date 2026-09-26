import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config/index.ts';

/**
 * ① 发现（scan）：递归查找含 .git 的目录。
 * - .git 可能是目录也可能是文件（worktree），按名称识别
 * - maxDepth 语义（06 §4.6）：仓库目录相对扫描根的最大层级，.git 位于其下一级
 * - 排除 node_modules / .Trash / Library 及隐藏目录；符号链接不跟随（防环）
 */
export async function discoverRepos(roots: readonly string[], warnings: string[]): Promise<string[]> {
  const repos: string[] = [];
  for (const root of roots) {
    await visit(root, 0, repos, warnings);
  }
  return repos.sort();
}

function isExcludedDirName(name: string): boolean {
  return name.startsWith('.') || config.scanExcludedDirs.includes(name);
}

async function visit(dir: string, depth: number, repos: string[], warnings: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`目录读取失败: ${dir} (${err instanceof Error ? err.message : String(err)})`);
    return;
  }

  if (entries.some((e) => e.name === '.git')) {
    repos.push(dir);
    return; // 已是仓库，内部不再下钻
  }

  if (depth >= config.maxDepth) return;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // 符号链接的 isDirectory 为 false，天然跳过
    if (isExcludedDirName(entry.name)) continue;
    await visit(join(dir, entry.name), depth + 1, repos, warnings);
  }
}
