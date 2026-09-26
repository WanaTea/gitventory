/**
 * 业务错误：携带期望的 HTTP 状态码与给用户看的中文说明。
 * 由 middleware/error-handler.ts 统一转成 { code, data: null, message } 响应，
 * 路由层因此不需要 try/catch（Express 5 会把 async 处理器的 reject 交给错误中间件）。
 */
export class GitOpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitOpError';
    this.status = status;
  }
}
