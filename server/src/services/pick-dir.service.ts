import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 唤起系统原生的「选择文件夹」对话框，把用户选中的绝对路径交回前端。
 *
 * 为什么只能由服务端弹：浏览器的目录选择 API（showDirectoryPicker / webkitdirectory）
 * 只给目录句柄、**不给绝对路径**，而扫描必须有绝对路径。本地服务进程与用户处在同一
 * 桌面会话，能直接调系统对话框 —— macOS 的 Finder 选择面板、Windows 的资源管理器选择框。
 *
 * 用户可能对着对话框挑很久，所以超时给得很宽；同时全进程只允许一个对话框（见 picking），
 * 否则两个标签页各点一次就会叠出两个框，用户不知道该回应哪个。
 */
const PICK_TIMEOUT_MS = 180_000;

const PROMPT = '选择要扫描的目录';

export type PickDirResult =
  | { status: 'picked'; path: string }
  | { status: 'canceled' }
  | { status: 'busy' }
  | { status: 'unsupported'; reason: string };

/** 同一时刻只允许一个选择对话框 */
let picking = false;

/**
 * Windows 用 Shell.Application.BrowseForFolder —— 就是资源管理器那个文件夹树选择框。
 * 输出编码显式设为 UTF8，否则中文路径会按 GBK 出来变成乱码。
 *
 * ⚠️ 这里不能用 `windowsHide: true`：它等价于 CREATE_NO_WINDOW，PowerShell 会以
 *「无控制台」的方式启动，BrowseForFolder 的模态框不会显示，进程却一直阻塞等用户操作 ——
 * 界面上表现为「点了没反应」，且 picking 一直为 true，之后每次点击都返回 409。
 * 要让「控制台不闪、窗口照常弹」，得用 PowerShell 自己的 -WindowStyle Hidden。
 * -STA 是 COM 的单线程套间要求，BrowseForFolder 依赖它。
 */
const WIN_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$shell = New-Object -ComObject Shell.Application',
  `$folder = $shell.BrowseForFolder(0, '${PROMPT}', 0, 0)`,
  'if ($folder -ne $null) { $folder.Self.Path }',
].join('\n');

/**
 * macOS 的 choose folder 会带上末尾斜杠（`/Users/x/code/`），统一去掉。
 *
 * 两个「根目录」不能真削：
 * - POSIX 根 `/` 削完是空串，补回 `/`；
 * - Windows 盘符根 `D:\` 削完只剩 `D:`，而那是**驱动器相对路径**（相对 D 盘当前目录），
 *   `node:path.isAbsolute('D:')` 为 false、前端 `^[A-Za-z]:[\\/]` 也匹配不上 ——
 *   选盘符根时会一路被判成「路径不正确」。必须补回反斜杠。
 */
function trimTrailingSlash(target: string): string {
  const trimmed = target.replace(/[/\\]+$/, '');
  if (trimmed === '') return '/';
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
  return trimmed;
}

async function runPicker(): Promise<PickDirResult> {
  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt "${PROMPT}")`;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: PICK_TIMEOUT_MS });
      const path = stdout.trim();
      return path === '' ? { status: 'canceled' } : { status: 'picked', path: trimTrailingSlash(path) };
    } catch (err) {
      // 用户点「取消」时 osascript 退出码为 1、stderr 是 "User canceled. (-128)" ——
      // 这是正常操作，不是故障，不能当错误抛给前端
      if (isUserCanceled(err)) return { status: 'canceled' };
      throw err;
    }
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', WIN_SCRIPT],
        { timeout: PICK_TIMEOUT_MS },
      );
      // 取消时 BrowseForFolder 返回 $null，脚本没有输出
      const path = stdout.replace(/^\uFEFF/, '').trim();
      return path === '' ? { status: 'canceled' } : { status: 'picked', path: trimTrailingSlash(path) };
    } catch (err) {
      if (isUserCanceled(err)) return { status: 'canceled' };
      throw err;
    }
  }

  // Linux 没有统一入口，两个常见实现都试；都没有就明确说清原因，
  // 而不是抛一个用户看不懂的 spawn ENOENT
  for (const [cmd, args] of [
    ['zenity', ['--file-selection', '--directory', `--title=${PROMPT}`]],
    ['kdialog', ['--getexistingdirectory', '.', '--title', PROMPT]],
  ] as const) {
    try {
      const { stdout } = await execFileAsync(cmd, [...args], { timeout: PICK_TIMEOUT_MS });
      const path = stdout.trim();
      return path === '' ? { status: 'canceled' } : { status: 'picked', path: trimTrailingSlash(path) };
    } catch (err) {
      if (isUserCanceled(err)) return { status: 'canceled' };
      if (isCommandMissing(err)) continue;
      throw err;
    }
  }
  return { status: 'unsupported', reason: '当前系统未安装 zenity 或 kdialog，无法弹出文件夹选择框' };
}

export async function pickDirectory(): Promise<PickDirResult> {
  if (picking) return { status: 'busy' };
  picking = true;
  try {
    return await runPicker();
  } finally {
    picking = false;
  }
}

function exitCodeOf(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
}

/**
 * 「用户取消」在各平台的形态都不一样：osascript 退出码 1 + "User canceled"，
 * zenity/kdialog 退出码 1，Windows 是空输出（不会走到这里）。
 * 按退出码 + 关键字一起判，避免把真实的执行失败误当成取消（那样用户点了取消却看到"成功"）。
 */
function isUserCanceled(err: unknown): boolean {
  return exitCodeOf(err) === 1 && /cancel/i.test(stderrOf(err));
}

function isCommandMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT';
}
