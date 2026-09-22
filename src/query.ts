/**
 * 查询编译：把结构化约束（日期、账号、语言）变成 X 高级搜索算符，拼到查询串上。
 *
 * 参数名对齐 xAI `x_search` 工具：`allowed_x_handles` / `excluded_x_handles`（各最多 20 个、
 * 不能同时给）、`from_date` / `to_date`。这些约束**由代码拼**，不交给模型——模型写的日期会漂。
 * @module
 */
import { XSearchError } from './errors.ts'

/** 与 xAI x_search 一致：单个名单最多 20 个账号。 */
export const MAX_HANDLES = 20

export type SearchMode = 'latest' | 'top'

export interface QuerySpec {
  /** 查询主体：自然语言里挑出的关键词，或已经写好的算符串。 */
  text: string
  /** YYYY-MM-DD，含当天。 */
  since?: string | undefined
  /** YYYY-MM-DD，不含当天（X 的 until: 语义）。 */
  until?: string | undefined
  /** 只要这些账号的帖子（最多 20 个）。 */
  allowedHandles?: readonly string[] | undefined
  /** 排除这些账号（最多 20 个）；不能与 allowedHandles 同时给。 */
  excludedHandles?: readonly string[] | undefined
  /** 语言码，如 en / zh / ja。 */
  lang?: string | undefined
  /** 不要回复。 */
  excludeReplies?: boolean | undefined
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LANG_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/

/**
 * 规范化账号名：去掉 @ 与首尾空白，校验字符集。
 * @param raw - 用户给的写法。
 * @returns 不带 @ 的账号名。
 */
export function normalizeHandle(raw: string): string {
  const handle = raw.trim().replace(/^@/, '')
  if (!HANDLE_RE.test(handle)) throw new XSearchError('BAD_REQUEST', `账号名不合法：${JSON.stringify(raw)}（只能是 1–15 位字母、数字、下划线）`)
  return handle
}

/**
 * 校验日期串。只认 YYYY-MM-DD；X 的 since:/until: 也只认这个。
 * @param value - 日期。
 * @param label - 出错时的字段名。
 * @returns 原串。
 */
export function assertDate(value: string, label: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new XSearchError('BAD_REQUEST', `${label} 必须是 YYYY-MM-DD，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 把约束编译成 X 算符并拼到查询主体后面。
 * @param spec - 查询主体与约束。
 * @returns 可直接放进 X 搜索框的串。
 */
export function compileQuery(spec: QuerySpec): string {
  const parts: string[] = []
  const text = spec.text.trim()
  if (text.length === 0) throw new XSearchError('BAD_REQUEST', '查询不能为空')
  parts.push(text)

  const allowed = (spec.allowedHandles ?? []).map(normalizeHandle)
  const excluded = (spec.excludedHandles ?? []).map(normalizeHandle)
  if (allowed.length > 0 && excluded.length > 0) throw new XSearchError('BAD_REQUEST', 'allowedHandles 与 excludedHandles 不能同时给')
  if (allowed.length > MAX_HANDLES || excluded.length > MAX_HANDLES) throw new XSearchError('BAD_REQUEST', `账号名单最多 ${MAX_HANDLES} 个`)
  if (allowed.length === 1) parts.push(`from:${allowed[0]}`)
  else if (allowed.length > 1) parts.push(`(${allowed.map(h => `from:${h}`).join(' OR ')})`)
  for (const handle of excluded) parts.push(`-from:${handle}`)

  if (spec.since !== undefined) parts.push(`since:${assertDate(spec.since, 'since')}`)
  if (spec.until !== undefined) parts.push(`until:${assertDate(spec.until, 'until')}`)
  if (spec.since !== undefined && spec.until !== undefined && spec.since > spec.until) {
    throw new XSearchError('BAD_REQUEST', `since (${spec.since}) 不能晚于 until (${spec.until})`)
  }
  if (spec.lang !== undefined && spec.lang.length > 0) {
    const lang = spec.lang.trim().toLowerCase()
    if (!LANG_RE.test(lang)) throw new XSearchError('BAD_REQUEST', `语言码不合法：${JSON.stringify(spec.lang)}`)
    parts.push(`lang:${lang}`)
  }
  if (spec.excludeReplies === true) parts.push('-filter:replies')
  return parts.join(' ')
}

/**
 * X 网页版的搜索地址。`f=live` 是「最新」，不带 f 是「热门」。
 * @param query - 已编译的查询串。
 * @param mode - 排序。
 * @returns URL。
 */
export function searchUrl(query: string, mode: SearchMode): string {
  const params = new URLSearchParams({ q: query, src: 'typed_query' })
  if (mode === 'latest') params.set('f', 'live')
  return `https://x.com/search?${params.toString()}`
}

/** 「人」搜索：X 的 People 标签。 */
export function peopleSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query, src: 'typed_query', f: 'user' })
  return `https://x.com/search?${params.toString()}`
}

const OPERATOR_RE = /(^|\s)(from|to|since|until|lang|min_faves|min_retweets|min_replies|filter|-filter|url|list|near|within_time|conversation_id|in_reply_to_tweet_id|quoted_tweet_id):\S/i

/**
 * 请求文本里已经带了 X 算符吗？带了就直通，不交给模型改写——用户要的是精确控制。
 * @param text - 请求文本。
 * @returns 是否含算符。
 */
export function looksLikeOperators(text: string): boolean {
  return OPERATOR_RE.test(text) || /(^|\s)-?"[^"]+"(\s|$)/.test(text) || /\s(OR)\s/.test(text)
}

/**
 * 从 URL 或纯数字里取帖子 id。
 * @param input - `https://x.com/<handle>/status/<id>` 或 `<id>`。
 * @returns 帖子 id；认不出时 undefined。
 */
export function extractPostId(input: string): string | undefined {
  const m = /status(?:es)?\/(\d{5,25})/.exec(input)
  if (m?.[1] !== undefined) return m[1]
  const trimmed = input.trim()
  return /^\d{5,25}$/.test(trimmed) ? trimmed : undefined
}
