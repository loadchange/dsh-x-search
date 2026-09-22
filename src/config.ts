/**
 * 插件配置。凭据（cookie）永远不在这里——配置会被 dump-config 打进模型上下文，
 * 这里只写 cookie **文件的路径**。
 * @module
 */
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export interface BrowserConfig {
  /** 无头运行。服务器没有显示器，只能是 true；本地调试可关。 */
  headless: boolean
  /** 自定义 Chromium 路径；留空用 Playwright 自己装的那份。 */
  executablePath: string
  /** 浏览器语言。会影响 X 返回的界面语言，不影响搜到的帖子。 */
  locale: string
  /** IANA 时区；留空跟随系统。持久化 profile 的指纹要稳定，定下来别来回改。 */
  timezoneId: string
  /** 页面导航超时（毫秒）。 */
  navigationTimeoutMs: number
  /** 等那条 GraphQL 响应的超时（毫秒）。 */
  responseTimeoutMs: number
  /** 空闲多久自动关掉浏览器省内存（毫秒）；0 = 常驻。 */
  idleCloseMs: number
}

export interface LimitsConfig {
  /** 滚动窗口内最多多少次 X 请求。X 网页版对搜索接口的限流约每 15 分钟 50 次，留余量。 */
  perWindow: number
  windowMs: number
  /** 每 UTC 日最多多少次 X 请求。这是账号安全阀，不是性能参数。 */
  perDay: number
  /** 两次 X 请求之间的最小间隔（毫秒）。 */
  minSpacingMs: number
  /** 一次搜索最多返回多少条帖子（硬顶；`limit` 参数只能往下调）。 */
  maxPostsPerRequest: number
  /** 一次搜索最多跑几条查询（硬顶）。 */
  maxQueriesPerRequest: number
}

export interface LlmConfig {
  /** 用 harness 的模型做「问题 → 查询」规划与「帖子 → 报告」写作。关掉就只有直通查询 + 原始引用格式。 */
  enabled: boolean
  maxTokens: number
  timeoutMs: number
  /** 规划阶段最多生成几条查询。 */
  planMaxQueries: number
}

export interface VisionConfig {
  /** 在服务端读帖子里的图片（描述 + 文字转录），客户端不必再自己抓图。 */
  enabled: boolean
  /** OpenAI 兼容接口基址所在的环境变量名；读不到用 https://api.deepseek.com。 */
  baseUrlEnv: string
  /** 钥匙所在的环境变量名；环境里没有就从 $DSH_HOME/.env 读。 */
  apiKeyEnv: string
  /** 能看图的模型 id。 */
  model: string
  /** 一次请求最多读几张图。 */
  maxImagesPerRequest: number
  /** 单张图最大字节数。 */
  maxImageBytes: number
  /** 抓图与读图各自的超时（毫秒）。 */
  timeoutMs: number
  /** 同一张图的描述缓存多久（毫秒）。 */
  cacheTtlMs: number
}

export interface XSearchConfig {
  enabled: boolean
  /** 浏览器 profile、限流计数、会话缓存的目录。**放在 .dsh 之外**——整棵 .dsh 被 chokidar 监视。留空用 $DSH_HOME/x-search。 */
  dataDir: string
  /** cookie 文件路径（0600，JSON：{"auth_token": "...", "ct0": "..."}）。留空 = dataDir/cookies.json。 */
  cookiesFile: string
  webEnabled: boolean
  /** 只绑回环。对外走 ssh 或 Cloudflare Tunnel（隧道后面必须开 authTokenEnv）。 */
  webHost: string
  webPort: number
  /**
   * 持有 Bearer 令牌的环境变量名。变量有值时，`/api/*` 一律要求 `Authorization: Bearer <令牌>`；
   * 变量为空则不鉴权（只适合纯回环访问）。令牌值走单元的 EnvironmentFile，不进配置。
   */
  authTokenEnv: string
  browser: BrowserConfig
  limits: LimitsConfig
  llm: LlmConfig
  vision: VisionConfig
  /** 非空时把每条原始 GraphQL 响应存进去（首次部署核对解析器用；平时留空，文件很大）。 */
  debugDumpDir: string
  /** 搜索会话缓存保留多久（毫秒），供 followup 追问。 */
  sessionTtlMs: number
}

export const XSearchConfig: z<XSearchConfig> = z.object({
  enabled: z.boolean().default(true).description('是否启用'),
  dataDir: z.string().default('').description('数据目录（浏览器 profile、限流计数、会话缓存）；放 .dsh 之外；留空用 $DSH_HOME/x-search'),
  cookiesFile: z.string().default('').description('cookie 文件路径（0600 JSON）；留空 = dataDir/cookies.json'),
  webEnabled: z.boolean().default(true).description('是否起 HTTP 接口'),
  webHost: z.string().default('127.0.0.1').description('HTTP 监听地址；只绑回环'),
  webPort: z.number().default(31890).description('HTTP 监听端口'),
  authTokenEnv: z.string().default('X_SEARCH_TOKEN').description('持有 Bearer 令牌的环境变量名；变量有值时 /api/* 要求鉴权'),
  browser: z.object({
    headless: z.boolean().default(true).description('无头运行'),
    executablePath: z.string().default('').description('自定义 Chromium 路径；留空用 Playwright 的'),
    locale: z.string().default('en-US').description('浏览器语言'),
    timezoneId: z.string().default('').description('IANA 时区；留空跟随系统时区。建议与出口 IP 所在地一致，定下来别改'),
    navigationTimeoutMs: z.number().default(30_000).description('导航超时（毫秒）'),
    responseTimeoutMs: z.number().default(25_000).description('等 GraphQL 响应的超时（毫秒）'),
    idleCloseMs: z.number().default(600_000).description('空闲多久关浏览器（毫秒）；0 = 常驻'),
  }) as z<BrowserConfig>,
  limits: z.object({
    perWindow: z.number().default(40).description('滚动窗口内最多请求数'),
    windowMs: z.number().default(900_000).description('滚动窗口长度（毫秒）'),
    perDay: z.number().default(600).description('每 UTC 日最多请求数'),
    minSpacingMs: z.number().default(1_500).description('两次请求最小间隔（毫秒）'),
    maxPostsPerRequest: z.number().default(80).description('一次搜索最多返回的帖子数（硬顶）'),
    maxQueriesPerRequest: z.number().default(5).description('一次搜索最多跑的查询数（硬顶）'),
  }) as z<LimitsConfig>,
  llm: z.object({
    enabled: z.boolean().default(true).description('用 harness 模型做规划与报告'),
    maxTokens: z.number().default(4_000).description('单次模型输出上限'),
    timeoutMs: z.number().default(90_000).description('单次模型调用超时（毫秒）'),
    planMaxQueries: z.number().default(3).description('规划阶段最多生成的查询数'),
  }) as z<LlmConfig>,
  vision: z.object({
    enabled: z.boolean().default(true).description('服务端读帖子里的图片'),
    baseUrlEnv: z.string().default('DEEPSEEK_BASE_URL').description('OpenAI 兼容接口基址所在的环境变量名'),
    apiKeyEnv: z.string().default('DEEPSEEK_API_KEY').description('钥匙所在的环境变量名（环境里没有就读 $DSH_HOME/.env）'),
    model: z.string().default('deepseek-chat').description('能看图的模型 id'),
    maxImagesPerRequest: z.number().default(6).description('一次请求最多读几张图'),
    maxImageBytes: z.number().default(4_000_000).description('单张图最大字节数'),
    timeoutMs: z.number().default(45_000).description('抓图 / 读图超时（毫秒）'),
    cacheTtlMs: z.number().default(21_600_000).description('图片描述缓存时长（毫秒）'),
  }) as z<VisionConfig>,
  debugDumpDir: z.string().default('').description('非空时把原始 GraphQL 响应存进去（调试用）'),
  sessionTtlMs: z.number().default(7_200_000).description('会话缓存保留时长（毫秒）'),
})

/**
 * 数据目录：显式配置优先，否则 $DSH_HOME/x-search，再否则当前目录下的 x-search-data。
 * @param config - 配置。
 * @param dshHome - `DSH_HOME` 环境变量。
 * @returns 绝对或相对路径。
 */
export function resolveDataDir(config: Pick<XSearchConfig, 'dataDir'>, dshHome: string | undefined): string {
  if (config.dataDir.length > 0) return config.dataDir
  if (dshHome !== undefined && dshHome.length > 0) return join(dshHome, 'x-search')
  return 'x-search-data'
}

/**
 * cookie 文件路径：显式配置优先，否则 dataDir/cookies.json。
 * @param config - 配置。
 * @param dataDir - 已解析的数据目录。
 * @returns 路径。
 */
export function resolveCookiesFile(config: Pick<XSearchConfig, 'cookiesFile'>, dataDir: string): string {
  return config.cookiesFile.length > 0 ? config.cookiesFile : join(dataDir, 'cookies.json')
}
