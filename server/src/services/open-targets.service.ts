import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { OpenTargetInfo } from '../shared/repo.ts';
import { expandHome } from '../utils/path.ts';

/**
 * 「用外部应用打开仓库」的全部行为面。
 *
 * 默认目标是**内置的一套常见应用**，可用 `config/open-targets.json` 覆盖或扩充
 * （模板见 `config/open-targets.example.json`）：每个目标按平台给出命令，末位由本模块
 * 追加仓库绝对路径；某平台没有命令 = 该平台不支持这个目标。
 *
 * 为什么不把应用写死在代码里：不同人的 IDE / 终端不同，且同一个应用在
 * macOS（.app + bundle id）与 Windows（PATH 上的 .exe）调用方式完全不同，
 * 让使用者用一份配置文件对齐自己的机器，比在代码里枚举全世界更省事。
 */

const execFileAsync = promisify(execFile);

/** 单次 open 的超时（含 macOS LaunchServices 冷启动） */
const OPEN_TIMEOUT_MS = 5_000;

/** 命令里出现该占位符时，替换为探测到的应用绝对路径（macOS `open -a` 需要） */
const APP_PLACEHOLDER = '%APP%';

export type OpenTargetDef = {
  id: string;
  label: string;
  /** 各平台命令；末位追加仓库路径。缺该平台 = 该平台不支持 */
  commands: Partial<Record<NodeJS.Platform, string[]>>;
  /** 平台专属展示名（例：Windows 上把 finder 叫「在资源管理器中打开」） */
  labels?: Partial<Record<NodeJS.Platform, string>>;
  /** 仅用于「装没装」探测的绝对路径候选；给了就按它判定可用性，支持 ~ */
  apps?: Partial<Record<NodeJS.Platform, string[]>>;
  /** 系统自带命令（explorer / xdg-open）：不必也不能去 PATH 里找 */
  always?: boolean;
  /** 成功也返回非 0 的命令（Windows 的 explorer 就返回 1） */
  ignoreExitCode?: boolean;
};

/** /Applications 与 ~/Applications 两处都找：用户确实会往后者装 */
function appCandidates(name: string): string[] {
  return [join('/Applications', name), join(homedir(), 'Applications', name)];
}

/**
 * 内置默认值。
 *
 * macOS 沿用「bundle id + open」而不是 CLI：本机实测 code CLI 不在 PATH，
 * 用 bundle id 还能免疫 App 改名与换目录。
 * Windows / Linux 走 PATH 上的命令；CodeBuddy / Trae / Warp 的 Windows 命令名
 * 未经实测，**故意留空**——宁可显示「当前系统未配置命令」让使用者填一行配置，
 * 也不要写一个猜的命令名，让用户点了之后看到一个莫名其妙的失败。
 */
const DEFAULT_TARGETS: readonly OpenTargetDef[] = [
  {
    id: 'finder',
    label: '在 Finder 中打开',
    labels: { win32: '在资源管理器中打开', linux: '在文件管理器中打开' },
    commands: { darwin: ['open'], win32: ['explorer'], linux: ['xdg-open'] },
    always: true,
    // explorer.exe 成功时也返回 1
    ignoreExitCode: true,
  },
  {
    id: 'vscode',
    label: '用 VSCode 打开',
    labels: { win32: '用 VS Code 打开' },
    commands: { darwin: ['open', '-b', 'com.microsoft.VSCode'], win32: ['code'], linux: ['code'] },
    apps: { darwin: appCandidates('Visual Studio Code.app') },
  },
  {
    id: 'codebuddy',
    label: '用 CodeBuddy CN 打开',
    commands: { darwin: ['open', '-b', 'com.tencent.codebuddycn'] },
    apps: { darwin: appCandidates('CodeBuddy CN.app') },
  },
  {
    id: 'trae',
    label: '用 Trae 打开',
    commands: { darwin: ['open', '-a', APP_PLACEHOLDER] },
    apps: { darwin: appCandidates('Trae.app') },
  },
  {
    id: 'warp',
    label: '在 Warp 中打开',
    commands: { darwin: ['open', '-b', 'dev.warp.Warp-Stable'] },
    apps: { darwin: appCandidates('Warp.app') },
  },
];

/** 用户配置文件位置：随仓库走，不依赖启动时的工作目录 */
const CONFIG_PATH = fileURLToPath(new URL('../../../config/open-targets.json', import.meta.url));

// ---- 配置解析（纯函数，无 IO）----

function parseCommands(value: unknown): Partial<Record<NodeJS.Platform, string[]>> | null {
  if (typeof value !== 'object' || value === null) return null;
  const out: Partial<Record<NodeJS.Platform, string[]>> = {};
  for (const [platform, command] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
      out[platform as NodeJS.Platform] = command as string[];
    }
  }
  return out;
}

function parseApps(value: unknown): Partial<Record<NodeJS.Platform, string[]>> {
  const parsed = parseCommands(value);
  return parsed === null ? {} : parsed;
}

/** labels 是「每平台一个字符串」，与 commands/apps 的数组不同形，故单独解析 */
function parsePlatformLabels(value: unknown): Partial<Record<NodeJS.Platform, string>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Partial<Record<NodeJS.Platform, string>> = {};
  for (const [platform, label] of Object.entries(value as Record<string, unknown>)) {
    if (typeof label === 'string' && label.trim() !== '') {
      out[platform as NodeJS.Platform] = label.trim();
    }
  }
  return out;
}

/** 单个目标：id 与 commands 缺一不可，其余可选；非法项由调用方丢弃并告警 */
export function parseTargetDef(value: unknown): OpenTargetDef | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const commands = parseCommands(raw.commands);
  if (id === '' || commands === null || Object.keys(commands).length === 0) return null;
  return {
    id,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id,
    commands,
    labels: parsePlatformLabels(raw.labels),
    apps: parseApps(raw.apps),
    always: raw.always === true,
    ignoreExitCode: raw.ignoreExitCode === true,
  };
}

/**
 * 合并内置默认与用户配置：
 * 默认**按 id 覆盖/追加**（只改一个应用时不必抄整份配置）；
 * 想彻底接管列表就写 `"replaceDefaults": true`（也就能删掉用不上的内置项）。
 */
export function mergeTargets(custom: readonly OpenTargetDef[], replaceDefaults: boolean): OpenTargetDef[] {
  if (replaceDefaults) return [...custom];
  const merged = [...DEFAULT_TARGETS];
  for (const def of custom) {
    const index = merged.findIndex((item) => item.id === def.id);
    if (index >= 0) merged[index] = def;
    else merged.push(def);
  }
  return merged;
}

// ---- 配置读取（IO，带 TTL）----

/**
 * 可用性 / 配置的短 TTL 缓存：用户可能中途安装应用或改配置，
 * 故不把结果定死在模块加载时；30s 内复用，改完配置最多等半分钟生效。
 */
const TTL_MS = 30_000;
let cache: { at: number; data: OpenTargetInfo[] } | null = null;

function readTargets(): OpenTargetDef[] {
  if (!existsSync(CONFIG_PATH)) return [...DEFAULT_TARGETS];
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    const raw = parsed as { targets?: unknown; replaceDefaults?: unknown };
    if (!Array.isArray(raw.targets)) return [...DEFAULT_TARGETS];
    const custom: OpenTargetDef[] = [];
    for (const item of raw.targets) {
      const def = parseTargetDef(item);
      if (def === null) {
        console.warn('[gitventory] open-targets.json 里有条目缺少 id 或 commands，已忽略');
        continue;
      }
      custom.push(def);
    }
    return mergeTargets(custom, raw.replaceDefaults === true);
  } catch (err) {
    // 配置写坏了不该让整个应用起不来：退回默认值并把原因说清楚
    console.warn(
      `[gitventory] 读取 config/open-targets.json 失败，改用内置默认值：${err instanceof Error ? err.message : String(err)}`,
    );
    return [...DEFAULT_TARGETS];
  }
}

// ---- 可用性探测 ----

/** 在 PATH 里找命令（不 spawn：探测本身不该产生进程） */
export function resolveCommand(command: string, platform: NodeJS.Platform = process.platform): string | null {
  if (isAbsolute(command)) return isFile(command) ? command : null;
  const pathValue = process.env.PATH ?? '';
  const extensions =
    platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
      : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 按平台解析展示名 */
export function labelOf(def: OpenTargetDef, platform: NodeJS.Platform = process.platform): string {
  return def.labels?.[platform] ?? def.label;
}

function resolveApp(def: OpenTargetDef, platform: NodeJS.Platform): string | null {
  for (const candidate of def.apps?.[platform] ?? []) {
    const path = expandHome(candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/** 可用性 + 不可用原因（原因直接透给前端 tooltip，避免前后端各猜一套文案） */
function availability(def: OpenTargetDef, platform: NodeJS.Platform): { available: boolean; reason: string } {
  const command = def.commands[platform];
  if (command === undefined || command.length === 0) {
    return { available: false, reason: `当前系统（${platform}）未配置该打开方式` };
  }
  if (def.always === true) return { available: true, reason: '' };
  if (def.apps !== undefined && (def.apps[platform] ?? []).length > 0) {
    return resolveApp(def, platform) !== null
      ? { available: true, reason: '' }
      : { available: false, reason: '未检测到对应应用，请先安装' };
  }
  const executable = resolveCommand(command[0] ?? '', platform);
  return executable !== null
    ? { available: true, reason: '' }
    : { available: false, reason: `未在 PATH 中找到命令 ${command[0] ?? ''}` };
}

/** 各打开目标在本机的可用性；结果供 /api/health 与 open 路由校验共用 */
export function resolveOpenTargets(): OpenTargetInfo[] {
  const now = Date.now();
  if (cache !== null && now - cache.at < TTL_MS) return cache.data;
  const data = readTargets().map((def) => {
    const { available, reason } = availability(def, process.platform);
    return { id: def.id, label: labelOf(def), available, reason };
  });
  cache = { at: now, data };
  return data;
}

/** 按 id 取定义（供 open 路由校验与执行共用同一份配置） */
export function findTarget(id: string): OpenTargetDef | null {
  return readTargets().find((def) => def.id === id) ?? null;
}

/** 用系统命令打开仓库目录；非 0 退出码直接抛出，由调用方转为明确错误 */
export async function openRepo(target: string, absPath: string): Promise<void> {
  const def = findTarget(target);
  const command = def?.commands[process.platform];
  if (def === null || command === undefined || command.length === 0) {
    throw new Error(`未配置打开方式 ${target}`);
  }
  const app = resolveApp(def, process.platform);
  const args = command.map((part) => (part === APP_PLACEHOLDER ? (app ?? part) : part));
  try {
    await execFileAsync(args[0] ?? '', [...args.slice(1), absPath], {
      timeout: OPEN_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (err) {
    // explorer.exe 打开成功也返回 1，按配置放行，避免把成功报成失败
    if (def.ignoreExitCode === true && exitCodeOf(err) === 1) return;
    throw err;
  }
}

function exitCodeOf(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}
