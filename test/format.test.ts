import { describe, expect, it } from 'vitest'
import { citation, formatPost, formatPosts, formatProfile } from '../src/format.ts'
import { parseTimeline, parseUserByScreenName } from '../src/parse.ts'
import { sampleSearch, userByScreenName, userResult } from './fixtures/timeline.ts'

describe('原始引用格式', () => {
  const posts = parseTimeline(sampleSearch().json).posts

  it('引用头是 @账号 - 日期 - 永久链接', () => {
    expect(citation(posts[0]!)).toBe('@alice - 2026-09-15 - https://x.com/alice/status/1001')
  })

  it('帖子块含互动数、正文引述与引用帖，可核对', () => {
    const text = formatPost(posts.find(post => post.id === '1003')!)
    expect(text).toContain('@bob - 2026-09-15 - https://x.com/bob/status/1003')
    expect(text).toContain('赞 5')
    expect(text).toContain('回复 @alice')
    expect(text).toContain('媒体 photo')
    expect(text).toContain('[图片 1] https://pbs.twimg.com/media/pic.jpg（未读图）')
    expect(text).toContain('引用：')
    expect(text).toContain('@alice - 2026-09-15 - https://x.com/alice/status/1001')
  })

  it('读过图的媒体把描述排进引用块，客户端不用再看图', () => {
    const post = { ...posts.find(post => post.id === '1003')!, media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/pic.jpg', description: '内容：一只手举着烤肠。文字：「这种肠我都是拿来喂狗的」' }] }
    expect(formatPost(post)).toContain('[图片 1] 内容：一只手举着烤肠。文字：「这种肠我都是拿来喂狗的」')
  })

  it('空列表明说「没有帖子」，而不是空白', () => {
    expect(formatPosts([], '标题')).toContain('没有返回任何帖子')
    expect(formatPosts(posts).split('\n\n')).toHaveLength(posts.length)
  })

  it('账号资料一眼能看全', () => {
    const profile = parseUserByScreenName(userByScreenName(userResult({ id: '1', handle: 'zed', name: 'Zed', followers: 10, verified: true })))!
    const text = formatProfile(profile)
    expect(text).toContain('@zed — Zed（已认证） — https://x.com/zed')
    expect(text).toContain('粉丝 10')
    expect(text).toContain('网址：https://example.com')
  })
})
