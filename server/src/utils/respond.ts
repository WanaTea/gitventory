import type { Response } from 'express';
import { API_SUCCESS, type ApiResponse } from '../shared/api.ts';

/** 成功响应包装：统一出口，避免各路由手写 { code, data, message } */
export function respond<T>(res: Response, data: T): void {
  const payload: ApiResponse<T> = { code: API_SUCCESS, data, message: '' };
  res.json(payload);
}

/** 直接失败响应（HTTP 状态与 body.code 一致，data 恒为 null）；由路由层做入参/前置校验时使用 */
export function fail(res: Response, status: number, code: number, message: string): void {
  const payload: ApiResponse<null> = { code, data: null, message };
  res.status(status).json(payload);
}
