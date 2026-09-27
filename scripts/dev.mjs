#!/usr/bin/env node
/**
 * 跨平台开发启动器：并行跑 server 与 web，中断时一起收掉。
 *
 * 为什么不用 `npm run dev -w server & npm run dev -w web & wait`：
 * 那是 POSIX shell 语法，Windows 的 cmd / PowerShell 直接不通；
 * 而且 `&` 拉起的 npm 子进程在被中断后容易残留，把 8787 / 5173 端口占住 ——
 * 下次启动会看到「端口被占用」或「后端是旧的」，很难查。
 *
 * 只依赖 Node 自身的 child_process，不引入额外依赖。
 */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const targets = ['server', 'web'];
const children = [];
let shuttingDown = false;

for (const target of targets) {
  const child = spawn(npm, ['run', 'dev', '-w', target], {
    stdio: 'inherit',
    // Windows 的 npm.cmd 是批处理脚本，不经 shell 直接 CreateProcess 会抛 EINVAL，
    // 必须借 cmd.exe 解析（与 scripts/start.mjs 保持一致）
    shell: process.platform === 'win32',
    // 非 Windows 上独立进程组，便于连子孙进程（vite / node）一起终止
    detached: process.platform !== 'win32',
  });
  children.push(child);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    // 任一子进程退出即整体退出：否则会出现「前端挂了，后端还在」的半可用状态
    console.log(`[dev] ${target} 已退出（code ${code}），停止其余进程`);
    shutdown(code ?? 0);
  });
}

/** 只走一次：重复收到信号时不再重复 kill */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[dev] 正在停止…');
  killAll('SIGTERM');

  // npm 与 `node --watch` 都是中间层，未必把信号转给真正在监听端口的进程。
  // 因此先给一段宽限期，期间每 150ms 检查一次：全都退出了就立刻返回（Ctrl+C 不粘手），
  // 到期仍有存活则补 SIGKILL（避免端口被一个看不见的进程占住）。
  const deadline = Date.now() + 3000;
  const tick = () => {
    if (allExited() || Date.now() > deadline) {
      killAll('SIGKILL');
      process.exit(code);
    }
    setTimeout(tick, 150);
  };
  tick();
}

function killAll(signal) {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, signal);
    } catch {
      // 进程可能已经自己退出了，忽略
    }
  }
}

function allExited() {
  return children.every((child) => child.exitCode !== null || child.signalCode !== null);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
