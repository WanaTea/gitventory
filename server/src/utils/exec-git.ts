import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { translateGitError } from './git-error-text.ts';

const execFileAsync = promisify(execFile);

export type ExecGitOptions = {
  cwd: string;
  timeoutMs?: number;
};

/** git 子进程结果：ok=false 表示 git 以非 0 退出（业务失败），不是执行失败 */
export type GitRunResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** 环境：强制关闭凭据交互，避免 fetch/push 卡在密码提示上把请求挂死 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export type GitAvailability = {
  available: boolean;
  version: string | null;
};

/**
 * git 是否可用（带 30s 缓存）。
 *
 * 「用户没装 git」是环境问题而非请求问题：不带缓存就得每次请求 spawn 一次做确认，
 * 带缓存则挂载新 git 后最多 30s 内自动恢复。探测失败不抛错 —— 调用方要的是「不可用」这个事实。
 */
const PROBE_TTL_MS = 30_000;
let probeCache: { at: number; result: GitAvailability } | null = null;

export async function probeGitAvailable(): Promise<GitAvailability> {
  const now = Date.now();
  if (probeCache !== null && now - probeCache.at < PROBE_TTL_MS) return probeCache.result;
  let result: GitAvailability;
  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      timeout: 5_000,
      windowsHide: true,
      encoding: 'utf-8',
    });
    result = { available: true, version: stdout.trim() };
  } catch {
    result = { available: false, version: null };
  }
  probeCache = { at: now, result };
  return result;
}

/**
 * 安全执行 git：一律 execFile + 参数数组（禁止 shell 字符串拼接），统一超时与输出上限。
 * git 非 0 退出时抛错 —— 仅用于「读」命令（失败即异常）。
 */
export async function execGit(args: readonly string[], options: ExecGitOptions): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf-8',
    env: GIT_ENV,
  });
  return stdout;
}

/**
 * 执行 git 并保留退出码与 stderr —— 写操作（checkout/pull/push/restore/branch -d）必须拿到 stderr
 * 才能给出可读的失败原因（冲突、无上游、未合并等）。
 *
 * 只有「进程本身起不来 / 超时被杀」这类拿不到退出码的情况才 reject；git 的业务失败一律 resolve 成 ok=false。
 */
export function execGitResult(args: readonly string[], options: ExecGitOptions): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf-8',
        env: GIT_ENV,
      },
      (err, stdout, stderr) => {
        if (err === null || err === undefined) {
          resolve({ ok: true, code: 0, stdout, stderr });
          return;
        }
        const code = typeof err.code === 'number' ? err.code : null;
        if (code === null) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve({ ok: false, code, stdout, stderr });
      },
    );
  });
}

/**
 * 从 git 输出里挑最可读的一行作为报错，并翻成中文。
 *
 * 挑选：git 习惯把真正的原因写在前面，末行常是 `hint: Disable this message ...` 这类噪音，
 * 故优先 error:/fatal:/CONFLICT，其次第一条非 hint 文本，最后才退到末行。
 * 翻译：见 git-error-text.ts —— 常见失败给中文说明，未命中的原样返回（不丢原文）。
 */
export function pickGitError(result: Pick<GitRunResult, 'stdout' | 'stderr'>, fallback: string): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return fallback;

  const prefixed = lines.find((line) => /^(error|fatal|CONFLICT|warning):/i.test(line));
  if (prefixed !== undefined) return translateGitError(prefixed);

  // 有些失败原因**不带 error:/fatal: 前缀**（例：`git pull` 的
  // "There is no tracking information for the current branch."）。此时不能简单取「第一条非 hint 行」——
  // 失败前 git 可能已经打印过无关输出（`From <url>` 的 fetch 进度），会被误当成原因。
  // 故优先取「有已知中文解释」的那一行：能被 translateGitError 命中，就说明它是已登记的失败文案。
  const known = lines.find((line) => translateGitError(line) !== line);
  if (known !== undefined) return translateGitError(known);

  const firstNonHint = lines.find((line) => !/^hint:/i.test(line));
  return firstNonHint ?? lines[lines.length - 1] ?? fallback;
}
