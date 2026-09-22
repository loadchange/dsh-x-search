import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { XSearchError } from '../src/errors.ts'
import type { SearchParams, SearchResult, XSearchService } from '../src/service.ts'
import { dispatch, isAuthorized, startWeb } from '../src/web.ts'

/** 只记录参数、按需抛错的假服务。 */
function fakeService(overrides: Partial<Record<'search' | 'user' | 'thread' | 'followup', (...args: unknown[]) => Promise<unknown>>> = {}): { service: XSearchService, calls: unknown[] } {
  const calls: unknown[] = []
  const ok: SearchResult = { sessionId: 's1', answer: 'A', posts: [], queries: ['q'], planner: 'passthrough', report: 'raw', warnings: [], elapsedMs: 1, limiter: { usedInWindow: 1, perWindow: 40, usedToday: 1, perDay: 600, day: '2026-09-22' } }
  const service = {
    status: () => ({ ok: true, browser: { open: false, session: 'unknown', requests: 0 }, limiter: ok.limiter, llm: { available: false }, vision: { available: false }, sessions: 0, dataDir: 'd', cookiesFile: 'c', updatedAt: 1 }),
    search: async (params: SearchParams) => { calls.push(['search', params]); return overrides.search === undefined ? ok : overrides.search(params) },
    user: async (params: unknown) => { calls.push(['user', params]); return overrides.user === undefined ? { ...ok, candidates: [], recentPosts: [] } : overrides.user(params) },
    thread: async (params: unknown) => { calls.push(['thread', params]); return overrides.thread === undefined ? { ...ok, thread: [], replies: [] } : overrides.thread(params) },
    followup: async (params: unknown) => { calls.push(['followup', params]); return overrides.followup === undefined ? ok : overrides.followup(params) },
  }
  return { service: service as unknown as XSearchService, calls }
}

describe('HTTP 派发', () => {
  it('healthz 与 status', async () => {
    const { service } = fakeService()
    expect(await dispatch(service, 'GET', '/healthz', {})).toMatchObject({ status: 200, value: { ok: true, session: 'unknown' } })
    expect((await dispatch(service, 'GET', '/api/status', {})).status).toBe(200)
  })

  it('search：参数逐个透传，类型错的当场 400', async () => {
    const { service, calls } = fakeService()
    const body = { request: 'zed', since: '2026-09-01', until: '2026-09-15', sort: 'top', lang: 'en', limit: 10, allowedHandles: ['a'], replyLang: 'Chinese', raw: true, queries: ['q1'] }
    const out = await dispatch(service, 'POST', '/api/search', body)
    expect(out.status).toBe(200)
    expect((out.value as { sessionId: string }).sessionId).toBe('s1')
    expect(calls[0]).toEqual(['search', { request: 'zed', queries: ['q1'], since: '2026-09-01', until: '2026-09-15', sort: 'top', lang: 'en', limit: 10, allowedHandles: ['a'], excludedHandles: undefined, excludeReplies: undefined, replyLang: 'Chinese', rules: undefined, raw: true, question: undefined }])
    await dispatch(service, 'POST', '/api/thread', { post: '90001', question: '什么意思' })
    expect(calls[1]).toEqual(['thread', { post: '90001', replyLang: undefined, raw: undefined, question: '什么意思' }])

    expect((await dispatch(service, 'POST', '/api/search', {})).value).toMatchObject({ ok: false, code: 'BAD_REQUEST', message: '缺 request' })
    expect((await dispatch(service, 'POST', '/api/search', { request: 'x', sort: 'best' })).value).toMatchObject({ code: 'BAD_REQUEST' })
    expect((await dispatch(service, 'POST', '/api/search', { request: 'x', limit: 0 })).value).toMatchObject({ code: 'BAD_REQUEST' })
    expect((await dispatch(service, 'POST', '/api/search', { request: 'x', allowedHandles: 'a' })).value).toMatchObject({ code: 'BAD_REQUEST' })
    expect((await dispatch(service, 'POST', '/api/search', [])).value).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('领域错误按码映射状态；限流带 Retry-After', async () => {
    const { service } = fakeService({
      search: async () => { throw new XSearchError('RATE_LIMITED', '慢点', { retryAfterMs: 90_000 }) },
      thread: async () => { throw new XSearchError('NOT_FOUND', '没有') },
      user: async () => { throw new XSearchError('SESSION_EXPIRED', '登录失效') },
      followup: async () => { throw new Error('boom') },
    })
    const limited = await dispatch(service, 'POST', '/api/search', { request: 'x' })
    expect(limited.status).toBe(429)
    expect(limited.headers).toEqual({ 'retry-after': '90' })
    expect(limited.value).toMatchObject({ ok: false, code: 'RATE_LIMITED', retryAfterMs: 90_000 })
    expect((await dispatch(service, 'POST', '/api/thread', { post: '1' })).status).toBe(404)
    expect((await dispatch(service, 'POST', '/api/user', { request: 'a' })).status).toBe(503)
    const internal = await dispatch(service, 'POST', '/api/followup', { sessionId: 's', request: 'q' })
    expect(internal.status).toBe(500)
    expect(internal.value).toMatchObject({ code: 'INTERNAL', message: 'boom' })
  })

  it('未知路由 404', async () => {
    const { service } = fakeService()
    expect((await dispatch(service, 'GET', '/api/nope', {})).status).toBe(404)
    expect((await dispatch(service, 'DELETE', '/api/search', {})).status).toBe(404)
  })
})

describe('Bearer 鉴权', () => {
  it('没配令牌就放行；配了就只认精确匹配，大小写与长度都要对', () => {
    expect(isAuthorized(undefined, undefined)).toBe(true)
    expect(isAuthorized(undefined, '')).toBe(true)
    expect(isAuthorized(undefined, 'secret')).toBe(false)
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true)
    expect(isAuthorized('bearer secret', 'secret')).toBe(true)
    expect(isAuthorized('Bearer  secret ', 'secret')).toBe(true)
    expect(isAuthorized('Bearer Secret', 'secret')).toBe(false)
    expect(isAuthorized('Bearer secre', 'secret')).toBe(false)
    expect(isAuthorized('Bearer secret2', 'secret')).toBe(false)
    expect(isAuthorized('Basic c2VjcmV0', 'secret')).toBe(false)
    expect(isAuthorized('secret', 'secret')).toBe(false)
  })

  it('真起服务：令牌来自配置指名的环境变量；/healthz 免鉴权，/api/* 没令牌 401、带令牌放行', async () => {
    const { service } = fakeService()
    const root = new Context()
    const web = await startWeb(root, { webHost: '127.0.0.1', webPort: 0, authTokenEnv: 'TEST_XS_TOKEN' }, service, { TEST_XS_TOKEN: 't0k3n' })
    try {
      expect(web.authenticated).toBe(true)
      const base = `http://127.0.0.1:${web.port}`
      expect((await fetch(`${base}/healthz`)).status).toBe(200)
      const denied = await fetch(`${base}/api/status`)
      expect(denied.status).toBe(401)
      expect(denied.headers.get('www-authenticate')).toBe('Bearer')
      expect(await denied.json()).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
      expect((await fetch(`${base}/api/search`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"request":"x"}' })).status).toBe(401)
      const ok = await fetch(`${base}/api/search`, { method: 'POST', headers: { authorization: 'Bearer t0k3n', 'content-type': 'application/json' }, body: '{"request":"x"}' })
      expect(ok.status).toBe(200)
      expect((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer t0k3n' } })).status).toBe(200)
    } finally {
      await web.close()
    }
  })

  it('环境变量为空时不鉴权（纯回环部署）', async () => {
    const { service } = fakeService()
    const root = new Context()
    const web = await startWeb(root, { webHost: '127.0.0.1', webPort: 0, authTokenEnv: 'TEST_XS_TOKEN' }, service, {})
    try {
      expect(web.authenticated).toBe(false)
      expect((await fetch(`http://127.0.0.1:${web.port}/api/status`)).status).toBe(200)
    } finally {
      await web.close()
    }
  })
})
