import { describe, expect, it } from 'vitest'
import { XSearchError } from '../src/errors.ts'
import { compileQuery, extractPostId, looksLikeOperators, normalizeHandle, peopleSearchUrl, searchUrl } from '../src/query.ts'

describe('compileQuery：约束由代码拼成 X 算符', () => {
  it('纯关键词原样保留', () => {
    expect(compileQuery({ text: 'zed editor release' })).toBe('zed editor release')
  })

  it('日期、语言、去回复按固定顺序追加', () => {
    expect(compileQuery({ text: 'zed', since: '2026-09-01', until: '2026-09-15', lang: 'EN', excludeReplies: true }))
      .toBe('zed since:2026-09-01 until:2026-09-15 lang:en -filter:replies')
  })

  it('单个允许账号用 from:，多个用括号 OR；@ 会被去掉', () => {
    expect(compileQuery({ text: 'compute', allowedHandles: ['@sama'] })).toBe('compute from:sama')
    expect(compileQuery({ text: 'compute', allowedHandles: ['sama', '@karpathy'] })).toBe('compute (from:sama OR from:karpathy)')
  })

  it('排除账号逐个 -from:', () => {
    expect(compileQuery({ text: 'ours', excludedHandles: ['ourhandle', 'bot'] })).toBe('ours -from:ourhandle -from:bot')
  })

  it('与 xAI x_search 一致：两个名单不能同时给、各最多 20 个', () => {
    expect(() => compileQuery({ text: 'x', allowedHandles: ['a'], excludedHandles: ['b'] })).toThrow(XSearchError)
    const many = Array.from({ length: 21 }, (_, i) => `h${i}`)
    expect(() => compileQuery({ text: 'x', allowedHandles: many })).toThrow(/最多 20/)
    expect(() => compileQuery({ text: 'x', allowedHandles: many.slice(0, 20) })).not.toThrow()
  })

  it('日期格式与先后顺序都校验', () => {
    expect(() => compileQuery({ text: 'x', since: '2026/09/01' })).toThrow(/YYYY-MM-DD/)
    expect(() => compileQuery({ text: 'x', since: '2026-13-01' })).toThrow(/YYYY-MM-DD/)
    expect(() => compileQuery({ text: 'x', since: '2026-09-15', until: '2026-09-01' })).toThrow(/不能晚于/)
  })

  it('空查询、坏账号名、坏语言码都拒绝', () => {
    expect(() => compileQuery({ text: '   ' })).toThrow(/不能为空/)
    expect(() => normalizeHandle('has space')).toThrow(/账号名不合法/)
    expect(() => normalizeHandle('a'.repeat(16))).toThrow(/账号名不合法/)
    expect(() => compileQuery({ text: 'x', lang: 'english' })).toThrow(/语言码/)
  })
})

describe('URL 与识别', () => {
  it('latest 走 f=live，top 不带 f；People 走 f=user', () => {
    expect(searchUrl('a b', 'latest')).toBe('https://x.com/search?q=a+b&src=typed_query&f=live')
    expect(searchUrl('a b', 'top')).toBe('https://x.com/search?q=a+b&src=typed_query')
    expect(peopleSearchUrl('zed')).toBe('https://x.com/search?q=zed&src=typed_query&f=user')
  })

  it('带算符的请求直通，不交给模型改写', () => {
    expect(looksLikeOperators('from:elonmusk min_faves:5000')).toBe(true)
    expect(looksLikeOperators('"exact phrase" here')).toBe(true)
    expect(looksLikeOperators('rust OR zig')).toBe(true)
    expect(looksLikeOperators('how are people reacting to the Figma IPO')).toBe(false)
    expect(looksLikeOperators('price is 3:1 today')).toBe(false)
  })

  it('从 URL 或纯数字取帖子 id', () => {
    expect(extractPostId('https://x.com/karpathy/status/2081195664479068350')).toBe('2081195664479068350')
    expect(extractPostId('https://x.com/i/status/2081195664479068350?s=20')).toBe('2081195664479068350')
    expect(extractPostId(' 2081195664479068350 ')).toBe('2081195664479068350')
    expect(extractPostId('https://x.com/karpathy')).toBeUndefined()
  })
})
