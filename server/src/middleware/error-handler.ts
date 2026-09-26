import type { ErrorRequestHandler } from 'express';
import { API_ERROR, type ApiResponse } from '../shared/api.ts';
import { translateGitError } from '../utils/git-error-text.ts';
import { GitOpError } from '../utils/git-op-error.ts';

/**
 * 统一错误出口。
 * - GitOpError：业务错误，HTTP 状态码与 body.code 取同一个值，message 直接面向用户；
 * - 其它：一律 500，避免把内部堆栈/命令细节泄漏给前端。
 * Express 5 会把 async 处理器的 reject 自动送到这里，路由层因此不需要 try/catch。
 *
 * 未预期的错误也过一遍 git 文案映射：这类错误里最常见的就是环境问题
 * （`spawn git ENOENT` —— 用户没装 git），直接抛英文原文等于没提示。
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof GitOpError) {
    const payload: ApiResponse<null> = { code: err.status, data: null, message: err.message };
    res.status(err.status).json(payload);
    return;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const message = translateGitError(raw);
  const payload: ApiResponse<null> = { code: API_ERROR, data: null, message };
  res.status(500).json(payload);
};
