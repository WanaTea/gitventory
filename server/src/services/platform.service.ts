import { PLATFORM_LABELS, type PlatformType } from '../shared/platform.ts';
import type { RemoteInfo, RepoPlatform } from '../shared/repo.ts';
import { config } from '../config/index.ts';

// host 后缀匹配规则（06 §3.2 平台字典）
const HOST_SUFFIX_RULES: ReadonlyArray<{ suffix: string; type: PlatformType }> = [
  { suffix: 'github.com', type: 'github' },
  { suffix: 'gitlab.com', type: 'gitlab' },
  { suffix: 'gitee.com', type: 'gitee' },
  { suffix: 'codeup.aliyun.com', type: 'codeup' },
  { suffix: 'e.coding.net', type: 'coding' },
];

/**
 * 按 host 判定平台。
 *
 * selfHostedHosts 由 GITVENTORY_SELF_HOSTED_HOSTS 提供（见 config/index.ts）：自建 GitLab 的域名
 * 没有可枚举规律，只能由使用者显式声明。同 IP 不同端口视为不同实例，但平台同为 gitlab。
 */
export function detectPlatformByHost(
  host: string,
  selfHostedHosts: readonly string[] = config.selfHostedHosts,
): PlatformType {
  const normalized = host.trim().toLowerCase();
  if (normalized === '') return 'none';
  // 自建实例优先匹配：用户声明的前缀比通用后缀更具体
  if (selfHostedHosts.some((prefix) => normalized.startsWith(prefix))) return 'gitlab';
  const hostname = normalized.split(':')[0] ?? '';
  for (const rule of HOST_SUFFIX_RULES) {
    if (hostname === rule.suffix || hostname.endsWith(`.${rule.suffix}`)) {
      return rule.type;
    }
  }
  return 'other';
}

/** 按 remote 解析仓库平台：origin 优先，其次第一个 remote；无 remote → none */
export function resolveRepoPlatform(remotes: readonly RemoteInfo[]): RepoPlatform {
  const primary = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  if (primary === undefined || primary.host === '') {
    return { type: 'none', label: PLATFORM_LABELS.none, host: '' };
  }
  const type = detectPlatformByHost(primary.host);
  return { type, label: PLATFORM_LABELS[type], host: primary.host };
}
