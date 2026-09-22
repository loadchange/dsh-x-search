/**
 * 浏览器会话：一个持久化的 Chromium profile，用导入的 cookie 保持登录，
 * 像一个真人那样打开 X 的页面，然后**读取页面自己收到的 GraphQL 响应**。
 *
 * 不解析 DOM——X 的页面结构月月变，但页面背后那几条接口（SearchTimeline、UserByScreenName、
 * UserTweets、TweetDetail）的名字很稳定，而且返回的是带互动数的结构化数据。
 *
 * 安全阀：
 * - 登录态失效（跳登录页、GraphQL 401/403）立即标记 `expired` 并拒绝后续请求，不反复撞；
 * - 同一时刻只跑一个页面操作；
 * - cookie 值永远不进日志、不进状态、不进错误信息。
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page, type Response } from 'playwright'
import type { BrowserConfig } from './config.ts'
import { XSearchError } from './errors.ts'
import { peopleSearchUrl, searchUrl, type SearchMode } from './query.ts'

export type SessionState = 'unknown' | 'ok' | 'expired'

export interface BrowserStatus {
  open: boolean
  session: SessionState
  lastOkAt?: string | undefined
  lastError?: string | undefined
  requests: number
  /** 最近一次导航里页面发出的 GraphQL 操作名（诊断接口改名用）。 */
  lastOperations?: string[] | undefined
}

/** 服务层依赖的最小接口；测试用假实现。 */
export interface XBrowserLike {
  search(query: string, mode: SearchMode): Promise<unknown>
  people(query: string): Promise<unknown>
  /** 打开用户主页：一次导航同时拿到资料与最近帖子。 */
  profilePage(handle: string): Promise<{ profile: unknown, tweets: unknown }>
  detail(postId: string): Promise<unknown>
  status(): BrowserStatus
  close(): Promise<void>
}

export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

export interface BrowserDeps {
  userDataDir: string
  cookiesFile: string
  config: BrowserConfig
  /** 非空时把每条原始响应写进去。 */
  dumpDir?: string | undefined
  logger: Logger
}

const REQUIRED_COOKIES = ['auth_token', 'ct0'] as const

/**
 * 读 cookie 文件。只认 JSON 对象 `{"auth_token": "...", "ct0": "...", ...}`；值不回显。
 * @param path - 文件路径。
 * @returns cookie 名 → 值。
 */
export function readCookiesFile(path: string): Record<string, string> {
  if (!existsSync(path)) throw new XSearchError('SESSION_EXPIRED', `cookie 文件不存在：${path}（见 deploy/README.md 导入步骤）`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new XSearchError('SESSION_EXPIRED', `cookie 文件不是合法 JSON：${path}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new XSearchError('SESSION_EXPIRED', 'cookie 文件必须是 JSON 对象')
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_]+$/.test(name)) out[name] = value
  }
  for (const name of REQUIRED_COOKIES) {
    if (out[name] === undefined) throw new XSearchError('SESSION_EXPIRED', `cookie 文件缺 ${name}`)
  }
  return out
}

/**
 * GraphQL 操作名在 URL 里的样子：`/i/api/graphql/<queryId>/<Operation>?...`。
 * `operation` 可以用 `|` 给几个别名（X 会改名：用户主页的时间线 2026-09 从 UserTweets 变成了 UserOriginalsTimeline）。
 */
function isOperation(url: string, operation: string): boolean {
  return new RegExp(`/graphql/[^/]+/(${operation})(\\?|$)`).test(url)
}

/** 带别名的操作名在结果里用第一个名字做键。 */
function operationKey(operation: string): string {
  return operation.split('|')[0] ?? operation
}

function looksLoggedOut(url: string): boolean {
  return /\/i\/flow\/login|\/login(\?|$)|\/account\/access/.test(url)
}

/** 持久化 Chromium 会话。 */
export class XBrowser implements XBrowserLike {
  private readonly deps: BrowserDeps
  private context: BrowserContext | undefined
  private page: Page | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | undefined
  private session: SessionState = 'unknown'
  private lastOkAt: string | undefined
  private lastError: string | undefined
  private lastOperations: string[] = []
  private requests = 0

  constructor(deps: BrowserDeps) {
    this.deps = deps
  }

  status(): BrowserStatus {
    return {
      open: this.context !== undefined,
      session: this.session,
      ...this.lastOkAt === undefined ? {} : { lastOkAt: this.lastOkAt },
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
      requests: this.requests,
      lastOperations: [...this.lastOperations],
    }
  }

  async search(query: string, mode: SearchMode): Promise<unknown> {
    const captured = await this.navigate(searchUrl(query, mode), ['SearchTimeline'])
    return captured['SearchTimeline']
  }

  async people(query: string): Promise<unknown> {
    const captured = await this.navigate(peopleSearchUrl(query), ['SearchTimeline'])
    return captured['SearchTimeline']
  }

  async profilePage(handle: string): Promise<{ profile: unknown, tweets: unknown }> {
    const captured = await this.navigate(`https://x.com/${encodeURIComponent(handle)}`, ['UserByScreenName', 'UserOriginalsTimeline|UserTweets'])
    return { profile: captured['UserByScreenName'], tweets: captured['UserOriginalsTimeline'] }
  }

  async detail(postId: string): Promise<unknown> {
    const captured = await this.navigate(`https://x.com/i/status/${encodeURIComponent(postId)}`, ['TweetDetail'])
    return captured['TweetDetail']
  }

  async close(): Promise<void> {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const context = this.context
    this.context = undefined
    this.page = undefined
    if (context !== undefined) {
      try {
        await context.close()
      } catch {
        // 关不掉也没什么可做的；进程退出会带走它。
      }
    }
  }

  /** 串行执行：同一时刻只有一个页面操作在跑。 */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async ensureOpen(): Promise<Page> {
    if (this.context !== undefined && this.page !== undefined && !this.page.isClosed()) return this.page
    const cookies = readCookiesFile(this.deps.cookiesFile)
    mkdirSync(this.deps.userDataDir, { recursive: true, mode: 0o700 })
    const cfg = this.deps.config
    let context: BrowserContext
    try {
      context = await chromium.launchPersistentContext(this.deps.userDataDir, {
        headless: cfg.headless,
        ...cfg.executablePath.length > 0 ? { executablePath: cfg.executablePath } : {},
        locale: cfg.locale,
        ...cfg.timezoneId.length > 0 ? { timezoneId: cfg.timezoneId } : {},
        viewport: { width: 1280, height: 900 },
        // 容器 / 小内存机器上 /dev/shm 太小会让 Chromium 直接崩。
        args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      })
    } catch (error) {
      this.lastError = `浏览器启动失败：${error instanceof Error ? error.message : String(error)}`
      throw new XSearchError('BROWSER_UNAVAILABLE', this.lastError, { cause: error })
    }
    await context.addCookies(Object.entries(cookies).map(([name, value]) => ({
      name,
      value,
      domain: '.x.com',
      path: '/',
      httpOnly: name === 'auth_token',
      secure: true,
      sameSite: 'None' as const,
    })))
    context.setDefaultNavigationTimeout(cfg.navigationTimeoutMs)
    this.context = context
    this.page = context.pages()[0] ?? await context.newPage()
    this.deps.logger.info('x-search：浏览器已启动（profile %s）', this.deps.userDataDir)
    return this.page
  }

  private touchIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    if (this.deps.config.idleCloseMs <= 0) return
    this.idleTimer = setTimeout(() => {
      void this.run(() => this.close()).catch(() => undefined)
    }, this.deps.config.idleCloseMs)
    this.idleTimer.unref()
  }

  /**
   * 打开一个页面并收下它发出的指定 GraphQL 响应。
   * @param url - 页面地址。
   * @param operations - 要等的操作名。
   * @returns 操作名 → 响应 JSON（没等到的不在里面）。
   */
  private navigate(url: string, operations: readonly string[]): Promise<Record<string, unknown>> {
    return this.run(async () => {
      if (this.session === 'expired') {
        throw new XSearchError('SESSION_EXPIRED', '登录态已失效，本进程不再向 X 发请求；重新导入 cookie 后重启单元。')
      }
      const page = await this.ensureOpen()
      this.requests += 1
      const cfg = this.deps.config

      // 先挂监听再导航；每个 promise 立刻挂一个空 catch，否则导航先失败时它们的拒绝会成为
      // unhandledRejection——dsh 宿主（0.1.5-rc.2 起）对此 2 秒内杀进程。真正的错误在下面 await 时再拿。
      const waits = operations.map(operation => page.waitForResponse(
        (response: Response) => isOperation(response.url(), operation),
        { timeout: cfg.responseTimeoutMs },
      ))
      for (const wait of waits) wait.catch(() => undefined)

      // 诊断：记下这次导航里页面发出的每个 GraphQL 操作名；开了 dumpDir 就把它们全部落盘。
      // X 改接口名（例如 UserTweets 换了名字）时，这是唯一能告诉你「它现在叫什么」的东西。
      const seenOperations: string[] = []
      const onResponse = (response: Response): void => {
        const m = /\/graphql\/[^/]+\/([A-Za-z0-9_]+)(\?|$)/.exec(response.url())
        if (m?.[1] === undefined) return
        const name = m[1]
        seenOperations.push(name)
        if (this.deps.dumpDir === undefined || this.deps.dumpDir.length === 0 || operations.some(op => op.split('|').includes(name))) return
        void response.json().then(body => { this.dump(`extra-${m[1]}`, body) }).catch(() => undefined)
      }
      page.on('response', onResponse)
      this.lastOperations = seenOperations

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navigationTimeoutMs })
      } catch (error) {
        page.off('response', onResponse)
        this.lastError = `导航失败：${error instanceof Error ? error.message : String(error)}`
        throw new XSearchError('UPSTREAM_TIMEOUT', this.lastError, { cause: error })
      }
      try {
        return await this.collect(page, waits, operations)
      } finally {
        page.off('response', onResponse)
      }
    })
  }

  /** 导航之后：核对登录态，逐个收下等到的响应。 */
  private async collect(page: Page, waits: Promise<Response>[], operations: readonly string[]): Promise<Record<string, unknown>> {
    const cfg = this.deps.config
    if (looksLoggedOut(page.url())) {
      this.session = 'expired'
      this.lastError = '被跳到登录页：cookie 已失效或被 X 撤销'
      throw new XSearchError('SESSION_EXPIRED', this.lastError)
    }

    const captured: Record<string, unknown> = {}
    for (const [index, wait] of waits.entries()) {
      const operation = operations[index]!
      let response: Response
      try {
        response = await wait
      } catch (error) {
        if (index === 0) {
          await this.snapshotFailure(page)
          this.lastError = `${cfg.responseTimeoutMs} 毫秒内没等到 ${operation} 响应`
          throw new XSearchError('UPSTREAM_TIMEOUT', `${this.lastError}（页面截图在 ${this.deps.userDataDir}/last-failure.png）`, { cause: error })
        }
        continue // 次要操作没来（例如账号受保护没有 UserTweets）：留空，调用方决定。
      }
      const status = response.status()
      if (status === 401 || status === 403) {
        this.session = 'expired'
        this.lastError = `${operation} 返回 HTTP ${status}：登录态失效`
        throw new XSearchError('SESSION_EXPIRED', this.lastError)
      }
      if (status === 429) {
        this.lastError = `${operation} 返回 HTTP 429：X 限流`
        throw new XSearchError('RATE_LIMITED', this.lastError, { retryAfterMs: 15 * 60_000 })
      }
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        this.lastError = `${operation} 响应不是 JSON（HTTP ${status}）`
        throw new XSearchError('UPSTREAM_CHANGED', this.lastError, { cause: error })
      }
      this.dump(operationKey(operation), body)
      captured[operationKey(operation)] = body
    }
    this.session = 'ok'
    this.lastOkAt = new Date().toISOString()
    this.touchIdle()
    return captured
  }

  private dump(operation: string, body: unknown): void {
    const dir = this.deps.dumpDir
    if (dir === undefined || dir.length === 0) return
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(join(dir, `${stamp}-${operation}.json`), JSON.stringify(body), { mode: 0o600 })
    } catch (error) {
      this.deps.logger.warn('x-search：写调试响应失败：%s', error instanceof Error ? error.message : String(error))
    }
  }

  private async snapshotFailure(page: Page): Promise<void> {
    try {
      await page.screenshot({ path: join(this.deps.userDataDir, 'last-failure.png') })
    } catch {
      // 截图只是诊断辅助。
    }
  }
}
