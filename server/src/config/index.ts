import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '../utils/path.ts';

/**
 * 默认扫描根的候选目录（只看一级，且**存在才纳入**）。
 *
 * 为什么不是一个写死的目录：初装用户的第一困惑是「为什么一个仓库都没扫到」。
 * 把仓库放在 ~/Documents 的开发者其实是少数，~/code、~/Projects 更常见；
 * 候选目录全不存在时退回 home 本身 —— 宁可多扫一层，也不要给一个空页面。
 * （scan.service 会跳过隐藏目录与 node_modules，因此 home 扫描的代价是可控的。）
 */
const DEFAULT_ROOT_CANDIDATES: readonly string[] = [
  'Documents',
  'Projects',
  'projects',
  'code',
  'Code',
  'dev',
  'Developer',
  'workspace',
  'Workspace',
  'repos',
  'src',
  'Desktop',
];

function resolveScanRoots(): string[] {
  const raw = process.env.GITVENTORY_SCAN_ROOTS;
  // 显式配置的根**不做存在性过滤**：用户可能先把路径写好，目录稍后才创建；
  // 过滤掉只会让人以为配置没生效。
  if (raw !== undefined && raw.trim() !== '') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(expandHome);
  }
  const home = homedir();
  const existing = DEFAULT_ROOT_CANDIDATES.map((name) => join(home, name)).filter((path) =>
    existsSync(path),
  );
  return existing.length > 0 ? existing : [home];
}

/**
 * 自建 Git 实例的 host 前缀（逗号分隔，默认空）。
 *
 * 这里原先写死过一个公司内网 IP —— 典型的「把开发者的私有环境编进通用代码」：
 * 公开仓库里既泄露内网地址，对他人也毫无意义。改成配置后默认空，
 * 未配置时自建实例归为「其他」，不影响任何功能。
 * 例：GITVENTORY_SELF_HOSTED_HOSTS=gitlab.example.com,10.0.0.8
 */
function resolveSelfHostedHosts(): string[] {
  const raw = process.env.GITVENTORY_SELF_HOSTED_HOSTS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

function resolvePort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 8787;
}

// 长期未动阈值（02 §6.1 / 01 §8：建议 90 天，可配）
function resolveStaleDays(): number {
  const parsed = Number.parseInt(process.env.GITVENTORY_STALE_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

const dataDir = expandHome(process.env.GITVENTORY_DATA_DIR ?? join(homedir(), '.gitventory'));

// 数据目录不存在则自动创建
mkdirSync(dataDir, { recursive: true });

const SCAN_EXCLUDED_DIRS: readonly string[] = ['node_modules', '.Trash', 'Library'];

export const config = {
  // 服务仅监听 127.0.0.1
  host: '127.0.0.1',
  port: resolvePort(),
  dataDir,
  scanRoots: resolveScanRoots(),
  selfHostedHosts: resolveSelfHostedHosts(),
  // 语义见 06 §4.6：仓库目录相对扫描根的最大层级（.git 位于其下一级）
  maxDepth: 5,
  scanExcludedDirs: SCAN_EXCLUDED_DIRS,
  gitTimeoutMs: 10_000,
  // 读写分开：fetch/pull/push 要走网络，10s 明显不够，但也不能无限等
  gitWriteTimeoutMs: 120_000,
  inspectConcurrency: 8,
  cacheTtlMs: 60_000,
  staleDays: resolveStaleDays(),
} as const;
