/**
 * 模型桥：两件事——把自然语言问题规划成几条 X 查询，把搜到的帖子写成带引用的报告。
 *
 * 走 harness 自己的模型路由（`ctx.get('llm')` + `ctx.get('agentDefaultModel')`），不另配 key。
 * 模型不可用不是异常：规划回落成「直通查询」，报告回落成原始引用格式，调用方仍然拿得到帖子。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
// 类型导入即引入这两个包对 Context 的模块增强：ctx.llm / ctx.agentDefaultModel。
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
import type { LlmConfig } from './config.ts'
import { formatPosts, formatProfile } from './format.ts'
import type { Post, Profile } from './parse.ts'
import type { SearchMode } from './query.ts'

export interface PlannedQuery {
  query: string
  mode: SearchMode
  why?: string | undefined
}

export type LlmOutcome<T> = { ok: true, value: T } | { ok: false, reason: string }

const PLAN_TOOL = 'x_search_plan'

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'X 搜索串：关键词与算符。' },
          mode: { type: 'string', enum: ['latest', 'top'], description: 'latest 按时间，top 按互动。' },
          why: { type: 'string', description: '一句话：这条查询想覆盖什么。' },
        },
        required: ['query', 'mode'],
      },
    },
  },
  required: ['queries'],
} as const

const PLAN_SYSTEM = `你是 X（Twitter）搜索的查询规划器，服务另一个 agent。把它的自然语言请求变成几条 X 高级搜索串。

可用算符：from:账号 · to:账号 · @账号 · "精确短语" · a OR b · -排除词 · #话题 · $代码 · url:域名 ·
min_faves:N · min_retweets:N · min_replies:N · filter:links · filter:media · filter:images · filter:videos ·
-filter:replies · filter:quote · filter:verified · -filter:retweets · conversation_id:ID。

规则：
- 不要写 since: / until: / lang: / from: 名单类约束——调用方会按参数自己拼上去。请求文本里已经写了的算符原样保留。
- 第一条查询最贴近字面；其余换说法、换语言、加/去互动门槛，覆盖遗漏。想要「反应 / 舆情」就至少一条 top 加 min_faves 过滤噪音。
- 关键词用帖子里真会出现的词（产品名、代号、人名、缩写），不要用「关于」「讨论」这类元词。
- 只调用 ${PLAN_TOOL} 工具作答，不写散文。`

const REPORT_SYSTEM = `你是 X（Twitter）调研报告的写手，服务另一个 agent，不是人。只根据给你的帖子写，不补充记忆里的东西。

- 每条引用写成 \`@账号 - YYYY-MM-DD - 永久链接\`，原文引述帖子的话，互动数跟在它描述的那条帖子后面。
- 先给结论，再分点展开；按立场 / 主题分组时说清每组多少条。
- 帖子为空或与问题无关就直说，不要编。数字、日期、账号、链接一律来自给定数据。
- 不要复述全部帖子；挑最能回答问题的，其余用「另有 N 条…」概括。`

const ANSWER_SYSTEM = `你在替另一个 agent 回答关于 X（Twitter）帖子的具体问题。只根据给你的帖子作答；帖子里的图片已由服务端读过，
「[图片 n] 内容：… 文字：…」就是图片的内容与文字转录，把它当事实用，不要说自己看不到图。

- 先直接回答问题（两三句），再用原文佐证：引用写成 \`@账号 - YYYY-MM-DD - 永久链接\`，原文引述帖子与图中文字。
- 梗图、段子、反讽要点明；涉及背景知识可以简短补充，但要和帖子本身分开说。
- 帖子信息不足以回答就直说缺什么，不要编。`

/**
 * 当前 profile 的模型路由；取不到即没配模型。
 * @param ctx - 上下文。
 * @returns 路由或 undefined。
 */
export function resolveRoute(ctx: Context): ModelSelection | undefined {
  // 必须经 ctx.get 取，不能写 ctx.agentDefaultModel：cordis 不允许没声明 inject 的 fiber 访问服务属性，
  // 而本插件顶层刻意不声明依赖——没有模型时搜索仍要照常跑。
  const defaults = ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined
  if (defaults === undefined) return undefined
  try {
    return defaults.currentSelection()
  } catch {
    return undefined
  }
}

type ToolCallBlock = Extract<ContentBlock, { type: 'tool-call' }>

/** 一次模型调用的裸结果。 */
interface RawCall {
  text: string
  call?: ToolCallBlock | undefined
}

/** 模型桥。构造不做任何调用；可用性每次调用时现查。 */
export class LlmBridge {
  private readonly ctx: Context
  private readonly config: LlmConfig

  constructor(ctx: Context, config: LlmConfig) {
    this.ctx = ctx
    this.config = config
  }

  /** 此刻能不能调模型（配置开着、有运行时、有路由）。 */
  available(): boolean {
    if (!this.config.enabled) return false
    return this.ctx.get('llm') !== undefined && resolveRoute(this.ctx) !== undefined
  }

  /**
   * 规划查询。
   * @param request - 自然语言请求。
   * @param maxQueries - 最多几条。
   * @param sortHint - 调用方指定的排序，有就全部沿用。
   * @returns 查询列表；模型不可用或没给出工具调用时 ok=false。
   */
  async plan(request: string, maxQueries: number, sortHint?: SearchMode): Promise<LlmOutcome<PlannedQuery[]>> {
    const user = [
      `请求：\n<request>\n${request}\n</request>`,
      `最多 ${maxQueries} 条查询。${sortHint === undefined ? '' : `排序一律用 ${sortHint}。`}`,
    ].join('\n\n')
    const raw = await this.call(PLAN_SYSTEM, user, [{ name: PLAN_TOOL, description: '给出查询列表。这是你唯一的输出方式。', parameters: PLAN_SCHEMA }])
    if (!raw.ok) return raw
    const call = raw.value.call
    if (call === undefined) return { ok: false, reason: '模型没有调用规划工具' }
    let parsed: unknown
    try {
      parsed = JSON.parse(call.arguments)
    } catch {
      return { ok: false, reason: '规划工具参数不是合法 JSON' }
    }
    const queries = Array.isArray((parsed as { queries?: unknown }).queries) ? (parsed as { queries: unknown[] }).queries : []
    const out: PlannedQuery[] = []
    for (const item of queries) {
      const q = item as { query?: unknown, mode?: unknown, why?: unknown }
      if (typeof q.query !== 'string' || q.query.trim().length === 0) continue
      const mode: SearchMode = sortHint ?? (q.mode === 'top' ? 'top' : 'latest')
      out.push({ query: q.query.trim(), mode, ...typeof q.why === 'string' ? { why: q.why } : {} })
      if (out.length >= maxQueries) break
    }
    return out.length === 0 ? { ok: false, reason: '规划结果里没有可用查询' } : { ok: true, value: out }
  }

  /**
   * 把帖子写成报告。
   * @param input - 请求、帖子、语言与附加规则。
   * @returns 报告文本。
   */
  async report(input: { request: string, posts: readonly Post[], profile?: Profile | undefined, replyLang?: string | undefined, rules?: string | undefined, queries?: readonly string[] | undefined }): Promise<LlmOutcome<string>> {
    const sections = [
      `请求：\n<request>\n${input.request}\n</request>`,
      input.queries === undefined || input.queries.length === 0 ? '' : `实际跑过的查询：\n${input.queries.map(q => `- ${q}`).join('\n')}`,
      input.profile === undefined ? '' : `账号资料：\n${formatProfile(input.profile)}`,
      `帖子（共 ${input.posts.length} 条）：\n${formatPosts(input.posts)}`,
      `报告语言：${input.replyLang ?? '与请求相同的语言'}。`,
      input.rules === undefined || input.rules.length === 0 ? '' : `调用方附加要求：\n${input.rules}`,
    ].filter(section => section.length > 0)
    const raw = await this.call(REPORT_SYSTEM, sections.join('\n\n'))
    if (!raw.ok) return raw
    const text = raw.value.text.trim()
    return text.length === 0 ? { ok: false, reason: '模型没有输出文本' } : { ok: true, value: text }
  }

  /**
   * 直接回答一个关于这些帖子的问题（帖子里的图片描述已在文本里）。
   * @param input - 问题、帖子、可选资料与语言。
   * @returns 回答文本。
   */
  async answer(input: { question: string, posts: readonly Post[], profile?: Profile | undefined, replyLang?: string | undefined, rules?: string | undefined }): Promise<LlmOutcome<string>> {
    const sections = [
      `问题：\n<question>\n${input.question}\n</question>`,
      input.profile === undefined ? '' : `账号资料：\n${formatProfile(input.profile)}`,
      `帖子（共 ${input.posts.length} 条，含图片描述）：\n${formatPosts(input.posts)}`,
      `回答语言：${input.replyLang ?? '与问题相同的语言'}。`,
      input.rules === undefined || input.rules.length === 0 ? '' : `调用方附加要求：\n${input.rules}`,
    ].filter(section => section.length > 0)
    const raw = await this.call(ANSWER_SYSTEM, sections.join('\n\n'))
    if (!raw.ok) return raw
    const text = raw.value.text.trim()
    return text.length === 0 ? { ok: false, reason: '模型没有输出文本' } : { ok: true, value: text }
  }

  /**
   * 在已有帖子上追问，不再搜索。
   * @param input - 上一次的请求、帖子与本次问题。
   * @returns 回答文本。
   */
  async followup(input: { priorRequest: string, question: string, posts: readonly Post[], replyLang?: string | undefined }): Promise<LlmOutcome<string>> {
    const user = [
      `上一次的请求：${input.priorRequest}`,
      `本次追问：\n<request>\n${input.question}\n</request>`,
      `可用帖子（上一次检索到的，共 ${input.posts.length} 条；没有新搜索）：\n${formatPosts(input.posts)}`,
      `回答语言：${input.replyLang ?? '与追问相同的语言'}。只根据这些帖子答；答不了就说需要新的搜索。`,
    ].join('\n\n')
    const raw = await this.call(REPORT_SYSTEM, user)
    if (!raw.ok) return raw
    const text = raw.value.text.trim()
    return text.length === 0 ? { ok: false, reason: '模型没有输出文本' } : { ok: true, value: text }
  }

  private async call(system: string, userText: string, tools?: { name: string, description: string, parameters: Record<string, unknown> }[]): Promise<LlmOutcome<RawCall>> {
    if (!this.config.enabled) return { ok: false, reason: '配置里关闭了模型（llm.enabled=false）' }
    const llm = this.ctx.get('llm') as LlmRuntime | undefined
    if (llm === undefined) return { ok: false, reason: 'ctx.llm 不可用：本 profile 没有挂 LLM 运行时' }
    const route = resolveRoute(this.ctx)
    if (route === undefined) return { ok: false, reason: '当前 profile 没有可用的模型路由（未配置 agentDefaultModel）' }

    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'plugin', plugin: 'x-search' },
    })]
    const assembler = new BlockAssembler()
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
        system,
        messages,
        ...tools === undefined ? {} : { tools },
        maxTokens: this.config.maxTokens,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
      for await (const chunk of stream) assembler.push(chunk)
    } catch (error) {
      return { ok: false, reason: `模型调用失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const finished = assembler.finish
    if (finished !== undefined && (finished.kind === 'error' || finished.kind === 'aborted')) {
      return { ok: false, reason: `模型请求以 ${finished.kind} 结束` }
    }
    const blocks = assembler.blocks()
    const text = blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n')
    const call = blocks.find((block): block is ToolCallBlock => block.type === 'tool-call')
    return { ok: true, value: { text, ...call === undefined ? {} : { call } } }
  }
}
