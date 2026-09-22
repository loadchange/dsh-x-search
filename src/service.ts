/**
 * 编排层：搜索 / 找人 / 读串 / 追问。
 *
 * 一次搜索 = 规划（模型或直通）→ 逐条查询（每条过限流器）→ 解析、去重、排序、截断 → 报告（模型或原始引用）。
 * 任何一步的模型不可用都退化成不用模型的版本，帖子照样返回；X 那边的错误（登录失效、限流、结构变了）
 * 带稳定码抛出，调用方能据此行动。
 * @module
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { XBrowser, type BrowserStatus, type XBrowserLike } from './browser.ts'
import { resolveCookiesFile, resolveDataDir, type XSearchConfig } from './config.ts'
import { XSearchError, asXSearchError } from './errors.ts'
import { formatPost, formatPosts, formatProfile } from './format.ts'
import { LlmBridge, type PlannedQuery } from './llm.ts'
import { RateLimiter, type LimiterStatus } from './limiter.ts'
import { parseTimeline, parseTweetDetail, parseUserByScreenName, type Post, type Profile } from './parse.ts'
import { compileQuery, extractPostId, looksLikeOperators, normalizeHandle, type SearchMode } from './query.ts'
import { Vision } from './vision.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    xSearch: XSearchService
  }
}

export interface SearchParams {
  /** 自然语言请求，或直接写 X 算符串。 */
  request: string
  /** 跳过规划，直接跑这些查询（约束仍会拼上）。 */
  queries?: readonly string[] | undefined
  since?: string | undefined
  until?: string | undefined
  sort?: SearchMode | undefined
  lang?: string | undefined
  /** 大约返回多少条；受 limits.maxPostsPerRequest 硬顶。 */
  limit?: number | undefined
  allowedHandles?: readonly string[] | undefined
  excludedHandles?: readonly string[] | undefined
  excludeReplies?: boolean | undefined
  /** 报告语言。 */
  replyLang?: string | undefined
  /** 附加给报告写手的要求。 */
  rules?: string | undefined
  /** 不用模型写报告，只给原始引用格式（规划仍可用模型）。 */
  raw?: boolean | undefined
  /** 要回答的问题：给了就在服务端直接作答（会读帖子里的图片），而不是写泛报告。 */
  question?: string | undefined
}

export interface SearchResult {
  sessionId: string
  answer: string
  posts: Post[]
  /** 实际跑过的查询（已拼约束）。 */
  queries: string[]
  planner: 'llm' | 'passthrough' | 'explicit'
  report: 'llm' | 'raw'
  warnings: string[]
  elapsedMs: number
  limiter: LimiterStatus
}

export interface UserParams {
  /** 账号名（带不带 @ 都行）或描述。 */
  request: string
  replyLang?: string | undefined
  raw?: boolean | undefined
  /** 要回答的问题：给了就直接作答（会读最近帖子里的图片）。 */
  question?: string | undefined
}

export interface UserResult {
  sessionId: string
  answer: string
  profile?: Profile | undefined
  candidates: Profile[]
  recentPosts: Post[]
  queries: string[]
  report: 'llm' | 'raw'
  warnings: string[]
  elapsedMs: number
}

export interface ThreadParams {
  /** 帖子 URL 或 id。 */
  post: string
  replyLang?: string | undefined
  raw?: boolean | undefined
  /** 要回答的问题：给了就直接作答；服务端会先读焦点帖与楼主串里的图片。 */
  question?: string | undefined
}

export interface ThreadResult {
  sessionId: string
  answer: string
  /** 焦点帖的原文块（正文 + 图片描述），客户端不必再自己抓图。 */
  original: string
  focal?: Post | undefined
  thread: Post[]
  replies: Post[]
  report: 'llm' | 'raw'
  warnings: string[]
  elapsedMs: number
}

export interface FollowupParams {
  sessionId: string
  request: string
  replyLang?: string | undefined
}

export interface StatusView {
  ok: boolean
  browser: BrowserStatus
  limiter: LimiterStatus
  llm: { available: boolean }
  vision: { available: boolean }
  sessions: number
  dataDir: string
  cookiesFile: string
  updatedAt: number
}

interface CachedSession {
  request: string
  posts: Post[]
  createdAt: number
}

/** 测试注入点：不起真浏览器。 */
export interface ServiceTestHooks {
  browser?: XBrowserLike
  llm?: Pick<LlmBridge, 'available' | 'plan' | 'report' | 'followup' | 'answer'>
  vision?: Pick<Vision, 'available' | 'describe'>
  now?: () => number
}

const DEFAULT_LIMIT = 30
const MAX_SESSIONS = 100

/** 编排服务。 */
export class XSearchService extends Service {
  private readonly config: XSearchConfig
  private readonly dataDir: string
  private readonly cookiesFile: string
  private readonly browser: XBrowserLike
  private readonly llm: Pick<LlmBridge, 'available' | 'plan' | 'report' | 'followup' | 'answer'>
  private readonly vision: Pick<Vision, 'available' | 'describe'>
  private readonly limiter: RateLimiter
  private readonly sessions = new Map<string, CachedSession>()
  private readonly now: () => number

  constructor(ctx: Context, config: XSearchConfig, hooks: ServiceTestHooks = {}) {
    super(ctx, 'xSearch')
    this.config = config
    this.now = hooks.now ?? (() => Date.now())
    this.dataDir = resolveDataDir(config, process.env['DSH_HOME'])
    this.cookiesFile = resolveCookiesFile(config, this.dataDir)
    if (hooks.browser === undefined) mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    this.limiter = new RateLimiter({
      perWindow: config.limits.perWindow,
      windowMs: config.limits.windowMs,
      perDay: config.limits.perDay,
      minSpacingMs: config.limits.minSpacingMs,
      now: this.now,
      ...hooks.browser === undefined ? { persistPath: join(this.dataDir, 'limiter.json') } : {},
    })
    this.browser = hooks.browser ?? new XBrowser({
      userDataDir: join(this.dataDir, 'chromium'),
      cookiesFile: this.cookiesFile,
      config: config.browser,
      ...config.debugDumpDir.length > 0 ? { dumpDir: config.debugDumpDir } : {},
      logger: ctx.logger,
    })
    this.llm = hooks.llm ?? new LlmBridge(ctx, config.llm)
    this.vision = hooks.vision ?? new Vision(config.vision, { dshHome: process.env['DSH_HOME'], logger: ctx.logger })
    ctx.effect(() => () => {
      void this.browser.close().catch(() => undefined)
    }, 'x-search browser')
  }

  status(): StatusView {
    const browser = this.browser.status()
    return {
      ok: browser.session !== 'expired',
      browser,
      limiter: this.limiter.status(),
      llm: { available: this.llm.available() },
      vision: { available: this.vision.available() },
      sessions: this.sessions.size,
      dataDir: this.dataDir,
      cookiesFile: this.cookiesFile,
      updatedAt: this.now(),
    }
  }

  /**
   * 搜索。
   * @param params - 请求与约束。
   * @returns 报告、帖子、查询轨迹。
   */
  async search(params: SearchParams): Promise<SearchResult> {
    const started = this.now()
    const request = params.request.trim()
    if (request.length === 0) throw new XSearchError('BAD_REQUEST', 'request 不能为空')
    const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, this.config.limits.maxPostsPerRequest))
    const warnings: string[] = []
    const constraints = {
      since: params.since,
      until: params.until,
      allowedHandles: params.allowedHandles,
      excludedHandles: params.excludedHandles,
      lang: params.lang,
      excludeReplies: params.excludeReplies,
    }
    // 先把约束编译一遍，参数错在跑任何查询之前就报出来。
    compileQuery({ text: request, ...constraints })

    let planned: PlannedQuery[]
    let planner: SearchResult['planner']
    if (params.queries !== undefined && params.queries.length > 0) {
      planned = params.queries.map(query => ({ query, mode: params.sort ?? 'latest' }))
      planner = 'explicit'
    } else if (looksLikeOperators(request) || !this.llm.available()) {
      planned = [{ query: request, mode: params.sort ?? 'latest' }]
      planner = 'passthrough'
      if (!looksLikeOperators(request) && !this.llm.available()) warnings.push('模型不可用：请求原样当作关键词搜索，没有做查询规划。')
    } else {
      const outcome = await this.llm.plan(request, Math.min(this.config.llm.planMaxQueries, this.config.limits.maxQueriesPerRequest), params.sort)
      if (outcome.ok) {
        planned = outcome.value
        planner = 'llm'
      } else {
        planned = [{ query: request, mode: params.sort ?? 'latest' }]
        planner = 'passthrough'
        warnings.push(`查询规划失败（${outcome.reason}），请求原样当作关键词搜索。`)
      }
    }

    const queries: string[] = []
    const posts: Post[] = []
    const seen = new Set<string>()
    for (const item of planned.slice(0, this.config.limits.maxQueriesPerRequest)) {
      const compiled = compileQuery({ text: item.query, ...constraints })
      const gate = this.limiter.acquire()
      if (!gate.ok) {
        if (posts.length > 0) {
          warnings.push(`配额用尽（${gate.reason}），后面的查询没跑：${compiled}`)
          break
        }
        throw new XSearchError('RATE_LIMITED', `本插件配额用尽（${gate.reason}），${Math.ceil(gate.retryAfterMs / 1000)} 秒后再试`, { retryAfterMs: gate.retryAfterMs })
      }
      queries.push(`${compiled}  [${item.mode}]`)
      const raw = await this.browser.search(compiled, item.mode)
      const parsed = parseTimeline(raw)
      if (parsed.entriesSeen === 0) {
        throw new XSearchError('UPSTREAM_CHANGED', `SearchTimeline 响应里没有任何条目：X 网页版可能改了结构。用 debugDumpDir 抓一份响应核对解析器。`)
      }
      if (parsed.posts.length === 0 && parsed.skipped > 0) warnings.push(`查询「${compiled}」有 ${parsed.skipped} 条帖子解析失败，可能是结构变了。`)
      for (const post of parsed.posts) {
        if (seen.has(post.id)) continue
        seen.add(post.id)
        posts.push(post)
      }
      if (posts.length >= limit * 2) break
    }

    const sortMode: SearchMode = params.sort ?? (planned.every(item => item.mode === 'top') ? 'top' : 'latest')
    posts.sort(sortMode === 'top'
      ? (a, b) => b.metrics.likes - a.metrics.likes || b.createdAt.localeCompare(a.createdAt)
      : (a, b) => b.createdAt.localeCompare(a.createdAt))
    const kept = posts.slice(0, limit)

    const question = params.question?.trim()
    if (question !== undefined && question.length > 0) warnings.push(...await this.readMedia(kept.slice(0, 5)))

    let answer: string
    let report: SearchResult['report'] = 'raw'
    if (params.raw !== true && this.llm.available() && question !== undefined && question.length > 0) {
      const outcome = await this.llm.answer({ question, posts: kept, replyLang: params.replyLang, rules: params.rules })
      if (outcome.ok) {
        answer = outcome.value
        report = 'llm'
      } else {
        warnings.push(`回答生成失败（${outcome.reason}），改为原始引用格式。`)
        answer = formatPosts(kept, `X 搜索结果（${kept.length} 条；查询：${queries.join(' ｜ ')}）`)
      }
    } else if (params.raw !== true && this.llm.available()) {
      const outcome = await this.llm.report({ request, posts: kept, replyLang: params.replyLang, rules: params.rules, queries })
      if (outcome.ok) {
        answer = outcome.value
        report = 'llm'
      } else {
        warnings.push(`报告生成失败（${outcome.reason}），改为原始引用格式。`)
        answer = formatPosts(kept, `X 搜索结果（${kept.length} 条；查询：${queries.join(' ｜ ')}）`)
      }
    } else {
      answer = formatPosts(kept, `X 搜索结果（${kept.length} 条；查询：${queries.join(' ｜ ')}）`)
    }

    const sessionId = this.remember(request, kept)
    return { sessionId, answer, posts: kept, queries, planner, report, warnings, elapsedMs: this.now() - started, limiter: this.limiter.status() }
  }

  /**
   * 找账号并看它最近的帖子。
   * @param params - 账号名或描述。
   * @returns 资料、候选、最近帖子。
   */
  async user(params: UserParams): Promise<UserResult> {
    const started = this.now()
    const request = params.request.trim()
    if (request.length === 0) throw new XSearchError('BAD_REQUEST', 'request 不能为空')
    const warnings: string[] = []
    const queries: string[] = []
    let handle: string | undefined
    let candidates: Profile[] = []

    if (/^@?[A-Za-z0-9_]{1,15}$/.test(request)) {
      handle = normalizeHandle(request)
    } else {
      this.gate()
      queries.push(`people: ${request}`)
      const parsed = parseTimeline(await this.browser.people(request))
      if (parsed.entriesSeen === 0) throw new XSearchError('UPSTREAM_CHANGED', 'People 搜索响应里没有任何条目：X 网页版可能改了结构。')
      candidates = parsed.users.slice(0, 5)
      handle = candidates[0]?.handle
      if (handle === undefined) {
        const answer = `没有找到匹配「${request}」的账号。`
        return { sessionId: this.remember(request, []), answer, candidates, recentPosts: [], queries, report: 'raw', warnings, elapsedMs: this.now() - started }
      }
      if (candidates.length > 1) warnings.push(`有 ${candidates.length} 个候选账号，下面读的是第一个（@${handle}）；其余见 candidates。`)
    }

    this.gate()
    queries.push(`profile: @${handle}`)
    const page = await this.browser.profilePage(handle)
    const profile = parseUserByScreenName(page.profile)
    if (profile === undefined) throw new XSearchError('NOT_FOUND', `账号 @${handle} 不存在或不可用`)
    const tweets = page.tweets === undefined ? { posts: [] as Post[] } : parseTimeline(page.tweets)
    const recentPosts = tweets.posts.slice(0, 20)
    if (page.tweets === undefined) warnings.push('没有拿到最近帖子（账号受保护，或页面没加载到）。')

    const question = params.question?.trim()
    if (question !== undefined && question.length > 0) warnings.push(...await this.readMedia(recentPosts.slice(0, 5)))

    let answer: string
    let report: UserResult['report'] = 'raw'
    if (params.raw !== true && this.llm.available() && question !== undefined && question.length > 0) {
      const outcome = await this.llm.answer({ question, posts: recentPosts, profile, replyLang: params.replyLang })
      if (outcome.ok) {
        answer = outcome.value
        report = 'llm'
      } else {
        warnings.push(`回答生成失败（${outcome.reason}），改为原始格式。`)
        answer = `${formatProfile(profile)}\n\n${formatPosts(recentPosts, '最近帖子')}`
      }
    } else if (params.raw !== true && this.llm.available()) {
      const outcome = await this.llm.report({ request: `介绍这个账号并概括其最近的发帖：${request}`, posts: recentPosts, profile, replyLang: params.replyLang, queries })
      if (outcome.ok) {
        answer = outcome.value
        report = 'llm'
      } else {
        warnings.push(`报告生成失败（${outcome.reason}），改为原始格式。`)
        answer = `${formatProfile(profile)}\n\n${formatPosts(recentPosts, '最近帖子')}`
      }
    } else {
      answer = `${formatProfile(profile)}\n\n${formatPosts(recentPosts, '最近帖子')}`
    }
    return { sessionId: this.remember(request, recentPosts), answer, profile, candidates, recentPosts, queries, report, warnings, elapsedMs: this.now() - started }
  }

  /**
   * 读一条帖子和它的串。
   * @param params - 帖子 URL 或 id。
   * @returns 焦点帖、楼主串、回复。
   */
  async thread(params: ThreadParams): Promise<ThreadResult> {
    const started = this.now()
    const postId = extractPostId(params.post)
    if (postId === undefined) throw new XSearchError('BAD_REQUEST', `认不出帖子 id：${JSON.stringify(params.post)}`)
    const warnings: string[] = []
    this.gate()
    const parsed = parseTweetDetail(await this.browser.detail(postId), postId)
    if (parsed.entriesSeen === 0) throw new XSearchError('UPSTREAM_CHANGED', 'TweetDetail 响应里没有任何条目：X 网页版可能改了结构。')
    if (parsed.focal === undefined) throw new XSearchError('NOT_FOUND', `帖子 ${postId} 不存在、已删除或不可见`)
    if (parsed.skipped > 0) warnings.push(`${parsed.skipped} 条帖子解析失败，可能是结构变了。`)

    // 先读图：焦点帖优先，再楼主串，再前几条回复；帖子的意思常常全在配图里。
    const all = [...parsed.thread, ...parsed.replies]
    warnings.push(...await this.readMedia([parsed.focal, ...parsed.thread, ...parsed.replies.slice(0, 3)]))
    const original = formatPost(parsed.focal)
    const question = params.question?.trim()
    const rawAnswer = [
      '焦点帖：',
      formatPost(parsed.focal),
      '',
      formatPosts(parsed.thread, `楼主串（${parsed.thread.length} 条，按时间）`),
      '',
      formatPosts(parsed.replies, `回复与引用（${parsed.replies.length} 条）`),
    ].join('\n')
    let answer = rawAnswer
    let report: ThreadResult['report'] = 'raw'
    if (params.raw !== true && this.llm.available()) {
      const outcome = question !== undefined && question.length > 0
        ? await this.llm.answer({ question, posts: [parsed.focal, ...parsed.thread.filter(post => post.id !== parsed.focal!.id), ...parsed.replies], replyLang: params.replyLang })
        : await this.llm.report({ request: `完整转述这条帖子及其串（楼主的连续帖按顺序、原文引述，图片按图片描述说明），再概括值得注意的回复与引用：${parsed.focal.url}`, posts: all, replyLang: params.replyLang })
      if (outcome.ok) {
        answer = outcome.value
        report = 'llm'
      } else {
        warnings.push(`${question === undefined ? '报告' : '回答'}生成失败（${outcome.reason}），改为原始格式。`)
      }
    }
    return { sessionId: this.remember(params.post, all), answer, original, focal: parsed.focal, thread: parsed.thread, replies: parsed.replies, report, warnings, elapsedMs: this.now() - started }
  }

  /**
   * 在上一次的结果上追问，不再搜索。
   * @param params - 会话 id 与问题。
   * @returns 回答。
   */
  async followup(params: FollowupParams): Promise<SearchResult> {
    const started = this.now()
    this.expireSessions()
    const cached = this.sessions.get(params.sessionId)
    if (cached === undefined) throw new XSearchError('NOT_FOUND', `会话 ${params.sessionId} 不存在或已过期（保留 ${Math.round(this.config.sessionTtlMs / 60_000)} 分钟）`)
    const question = params.request.trim()
    if (question.length === 0) throw new XSearchError('BAD_REQUEST', 'request 不能为空')
    if (!this.llm.available()) throw new XSearchError('MODEL_UNAVAILABLE', '追问需要模型；本 profile 当前没有可用的模型路由')
    const outcome = await this.llm.followup({ priorRequest: cached.request, question, posts: cached.posts, replyLang: params.replyLang })
    if (!outcome.ok) throw new XSearchError('MODEL_UNAVAILABLE', outcome.reason)
    return {
      sessionId: params.sessionId,
      answer: outcome.value,
      posts: cached.posts,
      queries: [],
      planner: 'explicit',
      report: 'llm',
      warnings: [],
      elapsedMs: this.now() - started,
      limiter: this.limiter.status(),
    }
  }

  /**
   * 在服务端读这些帖子（含被引用帖）里的图片，把描述写回 `media[].description`。
   * 视频取封面图。读不了不算错：返回一句告警，帖子照常。
   * @param posts - 帖子；undefined 项忽略。
   * @returns 告警（读图失败或未启用时一句）。
   */
  private async readMedia(posts: readonly (Post | undefined)[]): Promise<string[]> {
    const slots: { media: NonNullable<Post['media']>[number] }[] = []
    const urls: string[] = []
    const seen = new Set<string>()
    for (const post of posts) {
      if (post === undefined) continue
      for (const candidate of [post, post.quoted]) {
        for (const media of candidate?.media ?? []) {
          if (media.description !== undefined || seen.has(media.url)) continue
          seen.add(media.url)
          slots.push({ media })
          urls.push(media.url)
        }
      }
    }
    if (urls.length === 0) return []
    if (!this.vision.available()) return ['服务端读图未启用或没有模型钥匙：图片只给了地址与替代文字。']
    const described = await this.vision.describe(urls)
    const byUrl = new Map(described.map(item => [item.url, item]))
    let failed = 0
    for (const slot of slots) {
      const item = byUrl.get(slot.media.url)
      if (item?.description !== undefined) slot.media.description = item.description
      else if (item !== undefined) failed += 1
    }
    const skipped = urls.length - described.length
    const notes: string[] = []
    if (failed > 0) notes.push(`${failed} 张图读取失败（${described.find(item => item.error !== undefined)?.error ?? '未知原因'}）。`)
    if (skipped > 0) notes.push(`图片超过单次上限，${skipped} 张没读。`)
    return notes
  }

  /** 过限流器，不过就抛 RATE_LIMITED。 */
  private gate(): void {
    const gate = this.limiter.acquire()
    if (!gate.ok) {
      throw new XSearchError('RATE_LIMITED', `本插件配额用尽（${gate.reason}），${Math.ceil(gate.retryAfterMs / 1000)} 秒后再试`, { retryAfterMs: gate.retryAfterMs })
    }
  }

  private remember(request: string, posts: Post[]): string {
    this.expireSessions()
    const id = randomBytes(8).toString('hex')
    this.sessions.set(id, { request, posts, createdAt: this.now() })
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    return id
  }

  private expireSessions(): void {
    const cutoff = this.now() - this.config.sessionTtlMs
    for (const [id, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(id)
    }
  }
}

export { asXSearchError }
