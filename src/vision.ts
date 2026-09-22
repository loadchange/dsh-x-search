/**
 * 读图：把帖子里的图片抓到服务端，交给一个能看图的模型描述并转录文字。
 *
 * 为什么不走宿主的 `ctx.llm`：dsh-llm 传图要经附件服务登记，而这里只要一次「看图 → 一段文字」，
 * 直接打 OpenAI 兼容的 chat/completions（DeepSeek 官方接口收 `image_url`，实测 `deepseek-chat` 能读图）更直接。
 * 钥匙与基址沿用宿主已有的环境变量（DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL），读不到就退化为「不读图」，帖子照样返回。
 *
 * 客户端因此不必再自己抓图——那台机可能连 pbs.twimg.com 都不通。
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VisionConfig } from './config.ts'

export interface VisionDeps {
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  /** `$DSH_HOME`：环境变量里没有钥匙时，从 `$DSH_HOME/.env` 读（宿主自己也是这么读的）。 */
  dshHome?: string | undefined
  logger: { info(message: string, ...args: unknown[]): void, warn(message: string, ...args: unknown[]): void }
  now?: () => number
}

export interface Described {
  url: string
  /** 描述 + 文字转录；失败时 undefined，`error` 说明原因。 */
  description?: string | undefined
  error?: string | undefined
}

const PROMPT = '这是一条 X（Twitter）帖子里的图片。请用中文：先写「内容：」概括画面（人物、物体、场景、梗图的形式），'
  + '再写「文字：」逐字转录图中所有文字，保留原语言与换行（没有文字就写「无」）。不要猜测图外的事，不要评价。200 字以内。'

/**
 * 从环境变量或 `$DSH_HOME/.env` 取一个值。只返回值，不记录。
 * @param name - 变量名。
 * @param env - 环境。
 * @param dshHome - DSH_HOME。
 * @returns 值；没有时 undefined。
 */
export function resolveSecret(name: string, env: Record<string, string | undefined>, dshHome: string | undefined): string | undefined {
  const direct = env[name]
  if (direct !== undefined && direct.length > 0) return direct
  if (dshHome === undefined || dshHome.length === 0) return undefined
  const path = join(dshHome, '.env')
  if (!existsSync(path)) return undefined
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0 || line.slice(0, eq).trim() !== name) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    return value.length > 0 ? value : undefined
  }
  return undefined
}

/** 读图器。描述结果按图片 URL 缓存，同一张图不重复花钱。 */
export class Vision {
  private readonly config: VisionConfig
  private readonly deps: VisionDeps
  private readonly cache = new Map<string, { value: Described, at: number }>()
  private readonly now: () => number

  constructor(config: VisionConfig, deps: VisionDeps) {
    this.config = config
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /** 此刻能不能读图：配置开着且拿得到钥匙。 */
  available(): boolean {
    if (!this.config.enabled) return false
    return resolveSecret(this.config.apiKeyEnv, this.deps.env ?? process.env, this.deps.dshHome) !== undefined
  }

  private baseUrl(): string {
    const env = this.deps.env ?? process.env
    const configured = resolveSecret(this.config.baseUrlEnv, env, this.deps.dshHome)
    return (configured ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  }

  /**
   * 描述一批图片。超过上限的只保留前 N 张；单张失败不影响其它。
   * @param urls - 图片地址。
   * @returns 每张图的描述或失败原因，顺序同输入（截断后）。
   */
  async describe(urls: readonly string[]): Promise<Described[]> {
    const picked = [...new Set(urls)].slice(0, this.config.maxImagesPerRequest)
    if (picked.length === 0) return []
    if (!this.available()) return picked.map(url => ({ url, error: '读图未启用或没有模型钥匙' }))
    const out: Described[] = []
    for (const url of picked) {
      const cached = this.cache.get(url)
      if (cached !== undefined && this.now() - cached.at < this.config.cacheTtlMs) {
        out.push(cached.value)
        continue
      }
      const value = await this.describeOne(url)
      if (value.description !== undefined) this.cache.set(url, { value, at: this.now() })
      out.push(value)
    }
    return out
  }

  private async describeOne(url: string): Promise<Described> {
    const doFetch = this.deps.fetch ?? fetch
    const env = this.deps.env ?? process.env
    const key = resolveSecret(this.config.apiKeyEnv, env, this.deps.dshHome)
    if (key === undefined) return { url, error: '没有模型钥匙' }
    let bytes: Buffer
    let mime: string
    try {
      // 图片原图；`name=large` 是 X 的尺寸参数，够读字又不至于太大。
      const target = url.includes('?') ? url : `${url}?name=large`
      const res = await doFetch(target, { signal: AbortSignal.timeout(this.config.timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) dsh-x-search' } })
      if (!res.ok) return { url, error: `抓图失败：HTTP ${res.status}` }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) return { url, error: '抓图失败：空响应' }
      if (buf.length > this.config.maxImageBytes) return { url, error: `图片太大：${buf.length} 字节` }
      bytes = buf
      mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() || (url.endsWith('.png') ? 'image/png' : 'image/jpeg')
      if (!mime.startsWith('image/')) mime = 'image/jpeg'
    } catch (error) {
      return { url, error: `抓图失败：${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      const res = await doFetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 600,
          temperature: 0.2,
          messages: [{ role: 'user', content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
          ] }],
        }),
      })
      const body = await res.json() as { choices?: { message?: { content?: unknown } }[], error?: { message?: string } }
      if (!res.ok || body.error !== undefined) return { url, error: `读图模型失败：${body.error?.message ?? `HTTP ${res.status}`}` }
      const content = body.choices?.[0]?.message?.content
      const text = typeof content === 'string' ? content.trim() : ''
      return text.length === 0 ? { url, error: '读图模型没有输出' } : { url, description: text }
    } catch (error) {
      return { url, error: `读图模型失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
