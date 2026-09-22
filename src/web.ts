/**
 * HTTP 接口：给 grok skill（或任何能发 HTTP 的调用方）当后端。只绑回环；对外走 ssh 或隧道。
 *
 * 路由：
 * - GET  /healthz          存活 + 登录态
 * - GET  /api/status       浏览器、限流、模型、会话数
 * - POST /api/search       {request, since?, until?, sort?, lang?, limit?, allowedHandles?, excludedHandles?, excludeReplies?, replyLang?, rules?, raw?, queries?}
 * - POST /api/user         {request, replyLang?, raw?}
 * - POST /api/thread       {post, replyLang?, raw?}
 * - POST /api/followup     {sessionId, request, replyLang?}
 *
 * 错误统一为 `{ok:false, code, message, retryAfterMs?}`，状态码按 code 映射。
 * @module
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { XSearchConfig } from './config.ts'
import { XSearchError, asXSearchError, type XSearchErrorCode } from './errors.ts'
import type { XSearchService } from './service.ts'

const MAX_BODY_BYTES = 64 * 1024

/**
 * Bearer 鉴权。令牌为空 = 不鉴权（只应发生在纯回环部署）。比较用定长函数，长度不同直接判否。
 * @param header - 请求的 Authorization 头。
 * @param token - 配置的令牌；空串或 undefined 表示不鉴权。
 * @returns 是否放行。
 */
export function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (token === undefined || token.length === 0) return true
  if (header === undefined) return false
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (m?.[1] === undefined) return false
  const given = Buffer.from(m[1], 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const STATUS_BY_CODE: Record<XSearchErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  SESSION_EXPIRED: 503,
  BROWSER_UNAVAILABLE: 503,
  MODEL_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_CHANGED: 502,
  INTERNAL: 500,
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new XSearchError('BAD_REQUEST', '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new XSearchError('BAD_REQUEST', '请求体不是合法 JSON')
  }
}

type Body = Record<string, unknown>

function asBody(value: unknown): Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new XSearchError('BAD_REQUEST', '请求体必须是 JSON 对象')
  return value as Body
}

function optString(body: Body, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new XSearchError('BAD_REQUEST', `${key} 必须是字符串`)
  return value
}

function reqString(body: Body, key: string): string {
  const value = optString(body, key)
  if (value === undefined || value.trim().length === 0) throw new XSearchError('BAD_REQUEST', `缺 ${key}`)
  return value
}

function optBool(body: Body, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new XSearchError('BAD_REQUEST', `${key} 必须是布尔`)
  return value
}

function optInt(body: Body, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new XSearchError('BAD_REQUEST', `${key} 必须是正整数`)
  return value
}

function optStrings(body: Body, key: string): string[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new XSearchError('BAD_REQUEST', `${key} 必须是字符串数组`)
  return value as string[]
}

function optSort(body: Body): 'latest' | 'top' | undefined {
  const value = optString(body, 'sort')
  if (value === undefined) return undefined
  if (value !== 'latest' && value !== 'top') throw new XSearchError('BAD_REQUEST', 'sort 只能是 latest 或 top')
  return value
}

/**
 * 把一个请求派发到服务。独立成函数便于测试。
 * @param service - 服务。
 * @param method - HTTP 方法。
 * @param path - 路径（不含查询串）。
 * @param body - 已解析的请求体。
 * @returns 状态码与响应体。
 */
export async function dispatch(service: XSearchService, method: string, path: string, body: unknown): Promise<{ status: number, value: unknown, headers?: Record<string, string> }> {
  try {
    if (method === 'GET' && path === '/healthz') {
      const status = service.status()
      return { status: status.ok ? 200 : 503, value: { ok: status.ok, session: status.browser.session, updatedAt: status.updatedAt } }
    }
    if (method === 'GET' && path === '/api/status') return { status: 200, value: service.status() }
    if (method === 'POST' && path === '/api/search') {
      const b = asBody(body)
      const result = await service.search({
        request: reqString(b, 'request'),
        queries: optStrings(b, 'queries'),
        since: optString(b, 'since'),
        until: optString(b, 'until'),
        sort: optSort(b),
        lang: optString(b, 'lang'),
        limit: optInt(b, 'limit'),
        allowedHandles: optStrings(b, 'allowedHandles'),
        excludedHandles: optStrings(b, 'excludedHandles'),
        excludeReplies: optBool(b, 'excludeReplies'),
        replyLang: optString(b, 'replyLang'),
        rules: optString(b, 'rules'),
        raw: optBool(b, 'raw'),
        question: optString(b, 'question'),
      })
      return { status: 200, value: { ok: true, ...result } }
    }
    if (method === 'POST' && path === '/api/user') {
      const b = asBody(body)
      const result = await service.user({ request: reqString(b, 'request'), replyLang: optString(b, 'replyLang'), raw: optBool(b, 'raw'), question: optString(b, 'question') })
      return { status: 200, value: { ok: true, ...result } }
    }
    if (method === 'POST' && path === '/api/thread') {
      const b = asBody(body)
      const result = await service.thread({ post: reqString(b, 'post'), replyLang: optString(b, 'replyLang'), raw: optBool(b, 'raw'), question: optString(b, 'question') })
      return { status: 200, value: { ok: true, ...result } }
    }
    if (method === 'POST' && path === '/api/followup') {
      const b = asBody(body)
      const result = await service.followup({ sessionId: reqString(b, 'sessionId'), request: reqString(b, 'request'), replyLang: optString(b, 'replyLang') })
      return { status: 200, value: { ok: true, ...result } }
    }
    return { status: 404, value: { ok: false, code: 'NOT_FOUND', message: `没有 ${method} ${path}` } }
  } catch (error) {
    const domain = asXSearchError(error)
    const headers = domain.retryAfterMs === undefined ? {} : { 'retry-after': String(Math.ceil(domain.retryAfterMs / 1000)) }
    return {
      status: STATUS_BY_CODE[domain.code],
      value: { ok: false, code: domain.code, message: domain.message, ...domain.retryAfterMs === undefined ? {} : { retryAfterMs: domain.retryAfterMs } },
      headers,
    }
  }
}

export interface WebHandle {
  port: number
  /** 是否在鉴权（配置的环境变量有值）。 */
  authenticated: boolean
  close(): Promise<void>
}

/**
 * 起 HTTP 服务。
 * @param ctx - 上下文（日志）。
 * @param config - 监听地址、端口与令牌变量名。
 * @param service - 服务。
 * @param env - 环境变量（默认 process.env；测试注入）。
 * @returns 句柄。
 */
export async function startWeb(ctx: Context, config: Pick<XSearchConfig, 'webHost' | 'webPort' | 'authTokenEnv'>, service: XSearchService, env: Record<string, string | undefined> = process.env): Promise<WebHandle> {
  const token = config.authTokenEnv.length > 0 ? env[config.authTokenEnv] : undefined
  const authenticated = token !== undefined && token.length > 0
  let authFailures = 0

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
      else res.destroy()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const method = req.method ?? 'GET'
    // 隧道后面 /healthz 要给 Cloudflare 探活，不鉴权、也不泄露细节；其余一律要令牌。
    if (path !== '/healthz' && !isAuthorized(req.headers.authorization, token)) {
      authFailures += 1
      const from = req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '?'
      if (authFailures <= 20 || authFailures % 100 === 0) ctx.logger.warn('x-search：鉴权失败 %s %s（来自 %s，累计 %d 次）', method, path, String(from), authFailures)
      return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '需要 Authorization: Bearer <令牌>' }, { 'www-authenticate': 'Bearer' })
    }
    let body: unknown = {}
    if (method === 'POST') {
      try {
        body = await readBody(req)
      } catch (error) {
        const domain = asXSearchError(error, 'BAD_REQUEST')
        return sendJson(res, STATUS_BY_CODE[domain.code], { ok: false, code: domain.code, message: domain.message })
      }
    }
    const outcome = await dispatch(service, method, path, body)
    sendJson(res, outcome.status, outcome.value, outcome.headers ?? {})
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 只绑回环，且只绑一条 IPv4（隧道 self-check 要求源站端口上恰好一个 loopback 监听）。
    server.listen(config.webPort, config.webHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.webPort
  ctx.logger.info('x-search：HTTP 接口已监听 http://%s:%d（%s）', config.webHost, port, authenticated ? `Bearer 鉴权，令牌来自 $${config.authTokenEnv}` : '无鉴权，只适合回环访问')
  return {
    port,
    authenticated,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
