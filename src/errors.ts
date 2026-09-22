/**
 * 领域错误。每个码都对应一种调用方能据此行动的情形——不是「出错了」三个字。
 * @module
 */

/** 稳定错误码。HTTP 层按它映射状态码，skill 脚本按它决定退出码与提示。 */
export type XSearchErrorCode =
  | 'BAD_REQUEST'
  /** 浏览器里的登录态失效（被跳到登录页、GraphQL 401/403）。要人重新导入 cookie；本进程不再重试。 */
  | 'SESSION_EXPIRED'
  /** 本插件自己的配额（窗口 / 日上限 / 最小间隔）或 X 返回 429。 */
  | 'RATE_LIMITED'
  /** Chromium 起不来或崩了。 */
  | 'BROWSER_UNAVAILABLE'
  /** 页面打开了，但等不到那条 GraphQL 响应。 */
  | 'UPSTREAM_TIMEOUT'
  /** 响应拿到了，但解析出来是空的——多半是 X 网页版改了结构。 */
  | 'UPSTREAM_CHANGED'
  | 'NOT_FOUND'
  /** 本 profile 没挂模型，或模型调用失败。 */
  | 'MODEL_UNAVAILABLE'
  | 'INTERNAL'

/** 带稳定码的错误。 */
export class XSearchError extends Error {
  readonly code: XSearchErrorCode
  /** RATE_LIMITED 时：多久之后再试（毫秒）。 */
  readonly retryAfterMs: number | undefined

  constructor(code: XSearchErrorCode, message: string, options: { retryAfterMs?: number, cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'XSearchError'
    this.code = code
    this.retryAfterMs = options.retryAfterMs
  }
}

/** 把任意异常收敛成领域错误；已经是领域错误的原样返回。 */
export function asXSearchError(error: unknown, fallback: XSearchErrorCode = 'INTERNAL'): XSearchError {
  if (error instanceof XSearchError) return error
  return new XSearchError(fallback, error instanceof Error ? error.message : String(error), { cause: error })
}
