// 平台类型与字典（前后端共享；只放类型与常量，不放运行时逻辑）

export const PLATFORM_TYPES = [
  'github',
  'gitlab',
  'gitee',
  'codeup',
  'coding',
  'other',
  'none',
] as const;

export type PlatformType = (typeof PLATFORM_TYPES)[number];

export const PLATFORM_LABELS: Readonly<Record<PlatformType, string>> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitee: 'Gitee',
  codeup: 'Codeup',
  coding: 'CODING',
  other: '其他',
  none: '未接入',
};
