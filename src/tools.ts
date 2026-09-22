/**
 * harness 侧的模型工具：让跑在同一宿主里的 agent 也能直接搜 X。可选层——没有 `tools` 服务就不装。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue } from '@deepseek-ai/dsh-tools'
import { asXSearchError } from './errors.ts'
import type { XSearchService } from './service.ts'

const RESULT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  description: '搜索结果：报告正文、结构化帖子、查询轨迹与告警。',
  properties: {
    answer: { type: 'string', required: true, description: '带引用的报告，或原始引用列表。' },
    sessionId: { type: 'string', required: true, description: '会话 id；追问时传给 x_followup。' },
    posts: { type: 'json', required: true, description: '结构化帖子数组。' },
    queries: { type: 'array', required: true, items: { type: 'string' }, description: '实际跑过的查询。' },
    warnings: { type: 'array', required: true, items: { type: 'string' }, description: '降级与结构告警。' },
    error: {
      type: 'object',
      additionalProperties: false,
      description: '领域失败；出现时其余字段为空。',
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

type ToolResult = InferValue<typeof RESULT_OUTPUT>
/** 帖子数组是纯 JSON（解析器只产 string / number / boolean / 嵌套对象），这里只是把类型告诉 schema。 */
const asJson = (value: unknown): ToolResult['posts'] => value as ToolResult['posts']

function textBlock(header: string, value: ToolResult): ContentBlock[] {
  if (value.error !== undefined) return [{ type: 'text', text: `${header}\n失败：${value.error.code} — ${value.error.message}` }]
  const warn = value.warnings.length > 0 ? `\n\n注意：${value.warnings.join('；')}` : ''
  return [{ type: 'text', text: `${header}\n${value.answer}${warn}\n\n（会话 ${value.sessionId}；查询：${value.queries.join(' ｜ ')}）` }]
}

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    const domain = asXSearchError(error)
    return { answer: '', sessionId: '', posts: [], queries: [], warnings: [], error: { code: domain.code, message: domain.message } }
  }
}

/**
 * 注册四个工具。
 * @param scope - 已注入 tools 与 xSearch 的作用域。
 * @param service - 服务。
 */
export function registerTools(scope: Context, service: XSearchService): void {
  scope.tools.register(defineTool({
    name: 'x_search',
    description:
      '用自然语言搜 X（Twitter）：帖子、话题、舆情、某账号说过什么。返回带永久链接的引用报告与结构化帖子。'
      + '日期、账号名单、语言用参数给，不要写进请求文本；请求里已有 X 算符时会原样直通。',
    parameters: {
      request: { type: 'string', required: true, description: '自然语言请求，或 X 算符串。' },
      since: { type: 'string', description: 'YYYY-MM-DD，含当天。' },
      until: { type: 'string', description: 'YYYY-MM-DD，不含当天。' },
      sort: { type: 'string', enum: ['latest', 'top'], description: 'latest 按时间，top 按互动。' },
      lang: { type: 'string', description: '语言码，如 en / zh / ja。' },
      limit: { type: 'integer', description: '大约返回多少条（默认 30）。' },
      allowedHandles: { type: 'array', items: { type: 'string' }, description: '只要这些账号（最多 20）。' },
      excludedHandles: { type: 'array', items: { type: 'string' }, description: '排除这些账号（最多 20）；不能与 allowedHandles 同时给。' },
      replyLang: { type: 'string', description: '报告语言。' },
      raw: { type: 'boolean', description: '只要原始引用列表，不写报告。' },
      question: { type: 'string', description: '要回答的问题；给了就直接作答（服务端会读帖子里的图片），不写泛报告。' },
    },
    output: { schema: RESULT_OUTPUT, render: (_args, value) => textBlock('X 搜索', value) },
    execute: async (args) => guarded(async () => {
      const result = await service.search({
        request: args.request,
        since: args.since,
        until: args.until,
        sort: args.sort as 'latest' | 'top' | undefined,
        lang: args.lang,
        limit: args.limit,
        allowedHandles: args.allowedHandles,
        excludedHandles: args.excludedHandles,
        replyLang: args.replyLang,
        raw: args.raw,
        question: args.question,
      })
      return { answer: result.answer, sessionId: result.sessionId, posts: asJson(result.posts), queries: result.queries, warnings: result.warnings }
    }),
    presentCall: args => ({ card: 'generic', title: `X 搜索：${args.request.slice(0, 60)}`, kind: 'read', rawInput: args }),
  }))

  scope.tools.register(defineTool({
    name: 'x_user',
    description: '找一个 X 账号（给账号名或描述），返回资料与最近帖子。',
    parameters: {
      request: { type: 'string', required: true, description: '账号名（带不带 @ 都行）或描述。' },
      replyLang: { type: 'string', description: '报告语言。' },
      raw: { type: 'boolean', description: '只要原始格式。' },
      question: { type: 'string', description: '要回答的问题；给了就直接作答。' },
    },
    output: { schema: RESULT_OUTPUT, render: (_args, value) => textBlock('X 账号', value) },
    execute: async (args) => guarded(async () => {
      const result = await service.user({ request: args.request, replyLang: args.replyLang, raw: args.raw, question: args.question })
      return { answer: result.answer, sessionId: result.sessionId, posts: asJson(result.recentPosts), queries: result.queries, warnings: result.warnings }
    }),
    presentCall: args => ({ card: 'generic', title: `X 账号：${args.request.slice(0, 60)}`, kind: 'read', rawInput: args }),
  }))

  scope.tools.register(defineTool({
    name: 'x_thread',
    description: '读一条 X 帖子的全文、楼主串与回复。给帖子 URL 或 id。',
    parameters: {
      post: { type: 'string', required: true, description: '帖子 URL 或 id。' },
      replyLang: { type: 'string', description: '报告语言。' },
      raw: { type: 'boolean', description: '只要原始格式。' },
      question: { type: 'string', description: '要回答的问题，例如「这个帖子什么意思」；服务端读完图片后直接作答。' },
    },
    output: { schema: RESULT_OUTPUT, render: (_args, value) => textBlock('X 帖子串', value) },
    execute: async (args) => guarded(async () => {
      const result = await service.thread({ post: args.post, replyLang: args.replyLang, raw: args.raw, question: args.question })
      return { answer: result.answer, sessionId: result.sessionId, posts: asJson([...result.thread, ...result.replies]), queries: [], warnings: result.warnings }
    }),
    presentCall: args => ({ card: 'generic', title: `X 帖子串：${args.post.slice(0, 60)}`, kind: 'read', rawInput: args }),
  }))

  scope.tools.register(defineTool({
    name: 'x_followup',
    description: '在上一次 x_search 的结果上追问，不再搜索（便宜、快）。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '上一次返回的会话 id。' },
      request: { type: 'string', required: true, description: '追问。' },
      replyLang: { type: 'string', description: '回答语言。' },
    },
    output: { schema: RESULT_OUTPUT, render: (_args, value) => textBlock('X 追问', value) },
    execute: async (args) => guarded(async () => {
      const result = await service.followup({ sessionId: args.sessionId, request: args.request, replyLang: args.replyLang })
      return { answer: result.answer, sessionId: result.sessionId, posts: asJson(result.posts), queries: result.queries, warnings: result.warnings }
    }),
    presentCall: args => ({ card: 'generic', title: `X 追问：${args.request.slice(0, 60)}`, kind: 'read', rawInput: args }),
  }))
}
