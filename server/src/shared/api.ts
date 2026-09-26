// 统一响应包装：{ code, data, message }

export type ApiResponse<T> = {
  code: number;
  data: T;
  message: string;
};

export const API_SUCCESS = 0;
export const API_ERROR = 1;
