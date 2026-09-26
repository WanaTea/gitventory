import type { RepoLink } from '../shared/repo.ts';

export type ClassifyInput = {
  hasRemote: boolean;
  localOnlyCommits: number;
};

/**
 * 未接入分类（纯函数、无 IO，02 §7）：
 * N1 无任何 remote → N2 有 remote 但从未 push（localOnlyCommits > 0）
 */
export function classifyLink(input: ClassifyInput): RepoLink {
  if (!input.hasRemote) {
    return { status: 'unlinked', reasons: ['N1'] };
  }
  if (input.localOnlyCommits > 0) {
    return { status: 'unlinked', reasons: ['N2'] };
  }
  return { status: 'linked', reasons: [] };
}
