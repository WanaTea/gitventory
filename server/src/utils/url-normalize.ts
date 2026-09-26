export type RemoteUrlInfo = {
  host: string;
  fullPath: string;
};

function cleanFullPath(raw: string): string {
  let p = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.toLowerCase().endsWith('.git')) {
    p = p.slice(0, -4);
  }
  return p;
}

/**
 * remote URL → host[:port] + fullPath（多段路径完整保留）。
 * 支持：
 * - scp-like：git@host:path.git（剥离 user@，剥离 .git）
 * - https://host/a/b/c/name.git（多段路径完整保留，剥离内嵌 user:token@）
 * - 明文 http://host:port/...（host 保留端口）
 * - ssh:// / git:// 等带协议形式
 */
export function normalizeRemoteUrl(rawUrl: string): RemoteUrlInfo {
  const url = rawUrl.trim();
  if (url === '') {
    return { host: '', fullPath: '' };
  }

  // scp-like：user@host:path（path 不以 / 开头，无协议）
  const scpLike = /^([^@/?#]+)@([^:/?#]+):([^/].*)$/.exec(url);
  if (scpLike !== null) {
    return { host: scpLike[2] ?? '', fullPath: cleanFullPath(scpLike[3] ?? '') };
  }

  try {
    const parsed = new URL(url);
    // new URL 会剥离内嵌的 user / token，仅保留 hostname[:port]
    const host = parsed.port !== '' ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return { host, fullPath: cleanFullPath(decodeURIComponent(parsed.pathname)) };
  } catch {
    // 非 URL 形式，走兜底
  }

  // 兜底：host/path 形式
  const fallback = /^([^/]+)\/(.+)$/.exec(url);
  if (fallback !== null) {
    return { host: fallback[1] ?? '', fullPath: cleanFullPath(fallback[2] ?? '') };
  }
  return { host: url, fullPath: '' };
}
