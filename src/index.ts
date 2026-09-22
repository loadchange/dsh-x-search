/**
 * dsh-x-search —— 用自己的 X 账号做自然语言 X 搜索。
 *
 * 三层，各自独立、缺哪层少哪层：
 * 1. 服务 `xSearch`：浏览器会话 + 限流 + 编排（永远装）；
 * 2. HTTP 接口（`webEnabled`）：给 grok skill 当后端；
 * 3. harness 工具 `x_search` / `x_user` / `x_thread` / `x_followup`（有 `tools` 服务才装）。
 *
 * 模型规划与报告走宿主自己的模型路由；没有模型时退化成直通查询 + 原始引用，帖子照样返回。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { XSearchConfig } from './config.ts'
import { XSearchService } from './service.ts'
import { registerTools } from './tools.ts'
import { startWeb, type WebHandle } from './web.ts'

export const name = 'x-search'

/**
 * 顶层不声明依赖；逐层用 `ctx.inject`。
 *
 * 必须是数组形态——cordis 4 没有 `{ required, optional }` 这种写法，写成那样插件会静默永不加载。
 */
export const inject: string[] = []

export { XSearchConfig as Config }
export { XSearchService } from './service.ts'
export type { SearchParams, SearchResult, UserParams, UserResult, ThreadParams, ThreadResult, FollowupParams, StatusView } from './service.ts'
export { XSearchError } from './errors.ts'
export type { XSearchErrorCode } from './errors.ts'
export { compileQuery, searchUrl, peopleSearchUrl, looksLikeOperators, extractPostId, normalizeHandle, MAX_HANDLES } from './query.ts'
export type { QuerySpec, SearchMode } from './query.ts'
export { parseTimeline, parseTweetDetail, parseUserByScreenName, parsePost, parseProfile, parseAuthor, parseTwitterDate } from './parse.ts'
export type { Post, PostAuthor, PostMetrics, Profile, ParsedTimeline, ParsedThread } from './parse.ts'
export { formatPost, formatPosts, formatProfile, citation } from './format.ts'
export { RateLimiter } from './limiter.ts'
export { XBrowser, readCookiesFile } from './browser.ts'
export type { XBrowserLike, BrowserStatus } from './browser.ts'
export { dispatch, startWeb } from './web.ts'

/**
 * 装载插件。
 * @param ctx - 插件上下文。
 * @param config - 见 {@link XSearchConfig}。
 */
export function apply(ctx: Context, config: XSearchConfig): void {
  if (!config.enabled) {
    ctx.logger.info('x-search 已在配置里关闭。')
    return
  }

  ctx.plugin(XSearchService, config)

  ctx.inject(['xSearch', 'tools'], (scope) => {
    registerTools(scope, scope.xSearch)
  })

  if (config.webEnabled) {
    ctx.inject(['xSearch'], (scope) => {
      let handle: WebHandle | undefined
      const started = startWeb(scope, config, scope.xSearch).then(
        (opened) => { handle = opened },
        (error: unknown) => {
          // 端口被占不该把服务和工具一起打死，但也不能沉默。
          scope.logger.error('x-search：HTTP 接口未能监听 %s:%d：%s', config.webHost, config.webPort, error instanceof Error ? error.message : String(error))
        },
      )
      scope.effect(function* () {
        yield async () => {
          await started
          await handle?.close()
        }
      }, 'x-search web')
    })
  }
}
