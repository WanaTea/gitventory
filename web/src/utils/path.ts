/**
 * 扫描范围输入的跨平台校验。
 *
 * 原先这里用的是 `line.startsWith('/')`，Windows 用户填 `D:\develop\ai` 会被当成相对路径拒绝
 * —— 而服务端 `isAbsolute()` 本来认它，输入被挡在了客户端。
 *
 * 口径刻意**不按 process.platform 分支**：平台真值在后端（`node:path` 的 `isAbsolute`），
 * 前端再来一份必然漂移。前端只负责「不误杀合法输入」；某个目录到底能不能读，
 * 由扫描时的 readdir 结果说话（现在给的是 warning，不是报错）。
 */
export function isAbsoluteInput(line: string): boolean {
  if (line === '~') return true
  if (line.startsWith('~/') || line.startsWith('~\\')) return true
  if (line.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(line)) return true
  if (line.startsWith('\\\\')) return true
  return false
}
