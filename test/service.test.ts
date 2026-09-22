import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserStatus, XBrowserLike } from '../src/browser.ts'
import { XSearchConfig } from '../src/config.ts'
import { XSearchError } from '../src/errors.ts'
import type { LlmOutcome, PlannedQuery } from '../src/llm.ts'
import type { Post, Profile } from '../src/parse.ts'
import type { SearchMode } from '../src/query.ts'
import { XSearchService } from '../src/service.ts'
import { cursorEntry, itemEntry, sampleSearch, searchTimeline, tweetDetail, tweetResult, userByScreenName, userEntry, userResult, userTweetsTimeline } from './fixtures/timeline.ts'

/** 记录每次调用、按需返回夹具或抛错的假浏览器。 */
class FakeBrowser implements XBrowserLike {
  calls: { kind: string, arg: string, mode?: SearchMode }[] = []
  searchResponse: (query: string, mode: SearchMode) => unknown = () => sampleSearch().json
  peopleResponse: unknown = searchTimeline([userEntry('1', userResult({ id: '1', handle: 'zeddev', name: 'Zed' })), cursorEntry('Bottom', 'B')])
  profileResponse: { profile: unknown, tweets: unknown } = {
    profile: userByScreenName(userResult({ id: '1', handle: 'zeddev', name: 'Zed', followers: 10 })),
    tweets: userTweetsTimeline([itemEntry('9', tweetResult({ id: '9', user: userResult({ id: '1', handle: 'zeddev', name: 'Zed' }), text: 'shipped' }))]),
  }
  detailResponse: unknown = tweetDetail([itemEntry('90001', tweetResult({ id: '90001', user: userResult({ id: '1', handle: 'zeddev', name: 'Zed' }), text: 'shipped' }))])
  sessionState: BrowserStatus['session'] = 'ok'
  closed = false

  async search(query: string, mode: SearchMode): Promise<unknown> { this.calls.push({ kind: 'search', arg: query, mode }); return this.searchResponse(query, mode) }
  async people(query: string): Promise<unknown> { this.calls.push({ kind: 'people', arg: query }); return this.peopleResponse }
  async profilePage(handle: string): Promise<{ profile: unknown, tweets: unknown }> { this.calls.push({ kind: 'profile', arg: handle }); return this.profileResponse }
  async detail(postId: string): Promise<unknown> { this.calls.push({ kind: 'detail', arg: postId }); return this.detailResponse }
  status(): BrowserStatus { return { open: true, session: this.sessionState, requests: this.calls.length } }
  async close(): Promise<void> { this.closed = true }
}

/** 可开关的假模型。 */
class FakeLlm {
  on = true
  plans: PlannedQuery[] = [{ query: 'zed editor', mode: 'latest' }, { query: 'zed release min_faves:50', mode: 'top' }]
  reportCalls: { request: string, posts: readonly Post[], profile?: Profile | undefined }[] = []
  available(): boolean { return this.on }
  async plan(): Promise<LlmOutcome<PlannedQuery[]>> { return this.on ? { ok: true, value: this.plans } : { ok: false, reason: 'off' } }
  async report(input: { request: string, posts: readonly Post[], profile?: Profile | undefined }): Promise<LlmOutcome<string>> {
    this.reportCalls.push(input)
    return this.on ? { ok: true, value: `报告：${input.posts.length} 条` } : { ok: false, reason: 'off' }
  }
  async followup(input: { question: string, posts: readonly Post[] }): Promise<LlmOutcome<string>> {
    return this.on ? { ok: true, value: `追问答：${input.question}（${input.posts.length} 条）` } : { ok: false, reason: 'off' }
  }
  answerCalls: { question: string, posts: readonly Post[] }[] = []
  async answer(input: { question: string, posts: readonly Post[] }): Promise<LlmOutcome<string>> {
    this.answerCalls.push(input)
    return this.on ? { ok: true, value: `答：${input.question}（依据 ${input.posts.length} 条）` } : { ok: false, reason: 'off' }
  }
}

/** 假读图器：按地址给一句固定描述，并记录被问过哪些图。 */
class FakeVision {
  on = true
  asked: string[][] = []
  available(): boolean { return this.on }
  async describe(urls: readonly string[]): Promise<{ url: string, description?: string, error?: string }[]> {
    this.asked.push([...urls])
    return urls.map(url => url.includes('bad') ? { url, error: '抓图失败：HTTP 404' } : { url, description: `内容：${url.split('/').pop()} 的画面。文字：无` })
  }
}

let dir: string
let root: Context
let browser: FakeBrowser
let llm: FakeLlm
let vision: FakeVision
let clock: number

function make(overrides: Record<string, unknown> = {}): XSearchService {
  root = new Context()
  const { limits, ...rest } = overrides
  const config = new XSearchConfig({
    dataDir: dir,
    limits: { minSpacingMs: 0, perWindow: 100, perDay: 1000, ...(limits as Record<string, unknown> | undefined ?? {}) },
    ...rest,
  } as never)
  return new XSearchService(root, config, { browser, llm, vision, now: () => clock })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xs-service-'))
  browser = new FakeBrowser()
  llm = new FakeLlm()
  vision = new FakeVision()
  clock = Date.UTC(2026, 8, 22, 10, 0, 0)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('search', () => {
  it('模型规划 → 每条查询拼上约束 → 去重排序 → 模型报告', async () => {
    const service = make()
    const result = await service.search({ request: 'how are people reacting to the zed release', since: '2026-09-01', lang: 'en', limit: 10 })
    expect(result.planner).toBe('llm')
    expect(result.report).toBe('llm')
    expect(browser.calls.map(call => call.arg)).toEqual(['zed editor since:2026-09-01 lang:en', 'zed release min_faves:50 since:2026-09-01 lang:en'])
    expect(browser.calls.map(call => call.mode)).toEqual(['latest', 'top'])
    expect(result.queries).toEqual(['zed editor since:2026-09-01 lang:en  [latest]', 'zed release min_faves:50 since:2026-09-01 lang:en  [top]'])
    // 两次查询返回同一批帖子：去重后 3 条，按时间倒序
    expect(result.posts.map(post => post.id)).toEqual(['1003', '1001', '1004'])
    expect(result.answer).toBe('报告：3 条')
    expect(result.warnings).toEqual([])
    expect(result.sessionId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('请求里带算符就直通，不叫模型规划；sort=top 按赞排序', async () => {
    const service = make()
    const result = await service.search({ request: 'from:alice min_faves:10', sort: 'top' })
    expect(result.planner).toBe('passthrough')
    expect(browser.calls).toEqual([{ kind: 'search', arg: 'from:alice min_faves:10', mode: 'top' }])
    expect(result.posts.map(post => post.metrics.likes)).toEqual([99, 42, 5])
  })

  it('模型不可用：直通查询 + 原始引用格式，并在 warnings 里说明', async () => {
    llm.on = false
    const service = make()
    const result = await service.search({ request: 'zed editor' })
    expect(result.planner).toBe('passthrough')
    expect(result.report).toBe('raw')
    expect(result.answer).toContain('@alice - 2026-09-15 - https://x.com/alice/status/1001')
    expect(result.warnings[0]).toContain('模型不可用')
  })

  it('raw=true 时不叫模型写报告，但规划仍然用模型', async () => {
    const service = make()
    const result = await service.search({ request: 'zed reactions', raw: true })
    expect(result.planner).toBe('llm')
    expect(result.report).toBe('raw')
    expect(llm.reportCalls).toHaveLength(0)
  })

  it('显式 queries 跳过规划，且不超过 maxQueriesPerRequest', async () => {
    const service = make({ limits: { maxQueriesPerRequest: 2 } })
    const result = await service.search({ request: 'x', queries: ['a', 'b', 'c'] })
    expect(result.planner).toBe('explicit')
    expect(browser.calls.map(call => call.arg)).toEqual(['a', 'b'])
  })

  it('参数错在跑任何查询之前就报出来', async () => {
    const service = make()
    await expect(service.search({ request: 'x', since: '2026/09/01' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(service.search({ request: 'x', allowedHandles: ['a'], excludedHandles: ['b'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(service.search({ request: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(browser.calls).toEqual([])
  })

  it('响应结构认不出 → UPSTREAM_CHANGED；空搜索（只有游标）→ 正常返回 0 条', async () => {
    const service = make()
    browser.searchResponse = () => ({ data: { unexpected: true } })
    await expect(service.search({ request: 'from:nobody' })).rejects.toMatchObject({ code: 'UPSTREAM_CHANGED' })
    browser.searchResponse = () => searchTimeline([cursorEntry('Top', 'T'), cursorEntry('Bottom', 'B')])
    const empty = await service.search({ request: 'from:nobody', raw: true })
    expect(empty.posts).toEqual([])
    expect(empty.answer).toContain('没有返回任何帖子')
  })

  it('配额：第一条就被拒抛 RATE_LIMITED；中途被拒则返回已有帖子并告警', async () => {
    const service = make({ limits: { perWindow: 1, windowMs: 60_000 } })
    const first = await service.search({ request: 'zed reactions', raw: true })
    expect(first.warnings.some(w => w.includes('配额用尽'))).toBe(true)
    expect(browser.calls).toHaveLength(1)
    await expect(service.search({ request: 'again', raw: true })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(browser.calls).toHaveLength(1)
  })

  it('浏览器抛的领域错误原样上抛', async () => {
    const service = make()
    browser.searchResponse = () => { throw new XSearchError('SESSION_EXPIRED', '登录失效') }
    await expect(service.search({ request: 'zed', raw: true })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  })
})

describe('user', () => {
  it('给账号名直接读主页；给描述先搜人再读第一个候选', async () => {
    const service = make()
    const direct = await service.user({ request: '@zeddev', raw: true })
    expect(browser.calls.map(call => call.kind)).toEqual(['profile'])
    expect(direct.profile?.handle).toBe('zeddev')
    expect(direct.recentPosts.map(post => post.id)).toEqual(['9'])
    expect(direct.answer).toContain('@zeddev — Zed')

    browser.calls = []
    const searched = await service.user({ request: 'the team behind the zed editor', raw: true })
    expect(browser.calls.map(call => call.kind)).toEqual(['people', 'profile'])
    expect(searched.candidates.map(profile => profile.handle)).toEqual(['zeddev'])
    expect(searched.queries).toEqual(['people: the team behind the zed editor', 'profile: @zeddev'])
  })

  it('搜不到人：不抛，答案里说明；账号不存在：NOT_FOUND', async () => {
    const service = make()
    browser.peopleResponse = searchTimeline([cursorEntry('Bottom', 'B')])
    const none = await service.user({ request: 'nobody like this' })
    expect(none.profile).toBeUndefined()
    expect(none.answer).toContain('没有找到')
    browser.profileResponse = { profile: userByScreenName({ __typename: 'UserUnavailable' }), tweets: undefined }
    await expect(service.user({ request: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('模型可用时报告带资料', async () => {
    const service = make()
    const result = await service.user({ request: 'zeddev' })
    expect(result.report).toBe('llm')
    expect(llm.reportCalls[0]?.profile?.handle).toBe('zeddev')
  })
})

describe('thread', () => {
  it('URL 或 id 都行；焦点帖不在响应里 → NOT_FOUND', async () => {
    const service = make()
    const result = await service.thread({ post: 'https://x.com/zeddev/status/90001', raw: true })
    expect(browser.calls).toEqual([{ kind: 'detail', arg: '90001' }])
    expect(result.focal?.id).toBe('90001')
    expect(result.answer).toContain('焦点帖')
    await expect(service.thread({ post: '404404' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.thread({ post: 'not-a-post' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('服务端理解：读图 + 直接回答', () => {
  it('thread 带 question：先读焦点帖与楼主串的图，再让模型直接作答；原文块带图片描述', async () => {
    const service = make()
    const zed = userResult({ id: '1', handle: 'zeddev', name: 'Zed' })
    const focal = tweetResult({ id: '90001', user: zed, text: '遇到这种同事该怎么怼回去？ https://t.co/pic', media: [{ short: 'https://t.co/pic', type: 'photo', url: 'https://pbs.twimg.com/media/meme.jpg' }] })
    const reply = tweetResult({ id: '90002', user: userResult({ id: '2', handle: 'lang', name: 'L' }), text: '果然狗嘴里吐不出象牙', conversationId: '90001', inReplyTo: { id: '90001', handle: 'zeddev' } })
    browser.detailResponse = tweetDetail([itemEntry('90001', focal), itemEntry('90002', reply)])
    const result = await service.thread({ post: 'https://x.com/zeddev/status/90001', question: '这个帖子什么意思？', replyLang: 'Chinese' })
    expect(vision.asked).toEqual([['https://pbs.twimg.com/media/meme.jpg']])
    expect(result.focal?.media?.[0]?.description).toBe('内容：meme.jpg 的画面。文字：无')
    expect(result.original).toContain('[图片 1] 内容：meme.jpg 的画面。文字：无')
    expect(result.original).toContain('> 遇到这种同事该怎么怼回去？')
    expect(result.report).toBe('llm')
    expect(result.answer).toBe('答：这个帖子什么意思？（依据 2 条）')
    expect(llm.answerCalls[0]?.posts[0]?.media?.[0]?.description).toContain('meme.jpg')
    expect(result.warnings).toEqual([])
  })

  it('读图失败只告警不阻断；读图未启用时说明图片只给了地址；raw 模式也带上已读到的描述', async () => {
    const service = make()
    const zed = userResult({ id: '1', handle: 'zeddev', name: 'Zed' })
    const focal = tweetResult({ id: '90001', user: zed, text: 'x https://t.co/a https://t.co/b', media: [
      { short: 'https://t.co/a', type: 'photo', url: 'https://pbs.twimg.com/media/ok.jpg' },
      { short: 'https://t.co/b', type: 'photo', url: 'https://pbs.twimg.com/media/bad.jpg' },
    ] })
    browser.detailResponse = tweetDetail([itemEntry('90001', focal)])
    const result = await service.thread({ post: '90001', raw: true })
    expect(result.warnings).toEqual(['1 张图读取失败（抓图失败：HTTP 404）。'])
    expect(result.answer).toContain('[图片 1] 内容：ok.jpg 的画面。文字：无')
    expect(result.answer).toContain('[图片 2] https://pbs.twimg.com/media/bad.jpg（未读图）')

    vision.on = false
    const off = await service.thread({ post: '90001', raw: true })
    expect(off.warnings).toEqual(['服务端读图未启用或没有模型钥匙：图片只给了地址与替代文字。'])
  })

  it('search / user 带 question 时也读图并直接作答；不带 question 时不读图', async () => {
    const service = make()
    const plain = await service.search({ request: 'zed', raw: true })
    expect(vision.asked).toEqual([])
    expect(plain.report).toBe('raw')
    const asked = await service.search({ request: 'zed', question: '大家在夸什么？' })
    expect(vision.asked).toHaveLength(1) // 样本里只有一张图（1003 的 pic.jpg）
    expect(asked.answer).toBe('答：大家在夸什么？（依据 3 条）')
    const user = await service.user({ request: 'zeddev', question: '他最近在做什么？' })
    expect(user.answer).toBe('答：他最近在做什么？（依据 1 条）')
    expect(user.report).toBe('llm')
  })
})

describe('followup 与会话缓存', () => {
  it('在缓存的帖子上追问，不再搜索；过期或未知会话 → NOT_FOUND；没模型 → MODEL_UNAVAILABLE', async () => {
    const service = make({ sessionTtlMs: 1_000 })
    const first = await service.search({ request: 'zed', raw: true })
    const calls = browser.calls.length
    const answer = await service.followup({ sessionId: first.sessionId, request: 'who replied?' })
    expect(answer.answer).toBe('追问答：who replied?（3 条）')
    expect(browser.calls).toHaveLength(calls)
    await expect(service.followup({ sessionId: 'nope', request: 'q' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    clock += 2_000
    await expect(service.followup({ sessionId: first.sessionId, request: 'q' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const second = await service.search({ request: 'zed', raw: true })
    llm.on = false
    await expect(service.followup({ sessionId: second.sessionId, request: 'q' })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
  })
})

describe('status 与生命周期', () => {
  it('status 汇总浏览器、限流、模型；登录失效时 ok=false；fiber 销毁关浏览器', async () => {
    const service = make()
    expect(service.status()).toMatchObject({ ok: true, llm: { available: true }, vision: { available: true }, sessions: 0 })
    await service.search({ request: 'zed', raw: true })
    expect(service.status().sessions).toBe(1)
    // 规划出几条查询就占几个配额名额
    expect(service.status().limiter.usedToday).toBe(browser.calls.length)
    expect(browser.calls.length).toBe(llm.plans.length)
    browser.sessionState = 'expired'
    expect(service.status().ok).toBe(false)
    await root.fiber.dispose()
    expect(browser.closed).toBe(true)
  })
})
