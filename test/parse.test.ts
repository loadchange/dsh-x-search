import { describe, expect, it } from 'vitest'
import { parseAuthor, parsePost, parseProfile, parseTimeline, parseTweetDetail, parseTwitterDate, parseUserByScreenName } from '../src/parse.ts'
import { cursorEntry, itemEntry, moduleEntry, sampleSearch, searchTimeline, tombstone, tweetDetail, tweetResult, userByScreenName, userEntry, userResult, userTweetsTimeline } from './fixtures/timeline.ts'

describe('parseTwitterDate', () => {
  it('X 的日期格式转 ISO，含时区偏移', () => {
    expect(parseTwitterDate('Wed Oct 10 20:19:24 +0000 2018')).toBe('2018-10-10T20:19:24.000Z')
    expect(parseTwitterDate('Wed Oct 10 20:19:24 +0900 2018')).toBe('2018-10-10T11:19:24.000Z')
  })

  it('认不出的返回空串而不是抛错', () => {
    expect(parseTwitterDate('not a date')).toBe('')
    expect(parseTwitterDate(undefined)).toBe('')
  })
})

describe('parseTimeline：SearchTimeline', () => {
  const { json, ids } = sampleSearch()
  const parsed = parseTimeline(json)

  it('认出全部条目，帖子去壳去墓碑，转发折叠到原帖', () => {
    expect(parsed.entriesSeen).toBe(7)
    expect(parsed.posts.map(post => post.id)).toEqual(ids)
    expect(parsed.skipped).toBe(1) // 墓碑
    expect(parsed.cursorBottom).toBe('BOTTOM')
  })

  it('作者两种布局都认；t.co 展开、HTML 实体还原、互动数与浏览量齐全', () => {
    const original = parsed.posts.find(post => post.id === '1001')!
    expect(original.author).toMatchObject({ handle: 'alice', name: 'Alice', followers: 1234, verified: true })
    expect(original.text).toBe('Loving the new Zed release https://zed.dev/blog & more')
    expect(original.links).toEqual(['https://zed.dev/blog'])
    expect(original.metrics).toEqual({ likes: 42, reposts: 7, replies: 3, quotes: 1, bookmarks: 1, views: 5000 })
    expect(original.url).toBe('https://x.com/alice/status/1001')
    expect(original.createdAt).toBe('2026-09-15T10:20:30.000Z')
    // 转发条目（legacy 布局的 bob 转 alice）被折叠成原帖并标注转发者；不重复计入。
    expect(parsed.posts.filter(post => post.id === '1001')).toHaveLength(1)
  })

  it('长帖取 note_tweet 全文，媒体短链剥掉，引用与回复关系保留', () => {
    const reply = parsed.posts.find(post => post.id === '1003')!
    expect(reply.text.startsWith('@alice 这是一条很长的帖子')).toBe(true)
    expect(reply.text).not.toContain('t.co/pic')
    expect(reply.media).toEqual([{ type: 'photo', url: 'https://pbs.twimg.com/media/pic.jpg' }])
    expect(reply.inReplyToId).toBe('1001')
    expect(reply.inReplyToHandle).toBe('alice')
    expect(reply.conversationId).toBe('1001')
    expect(reply.quoted?.id).toBe('1001')
    expect(reply.quoted?.quoted).toBeUndefined() // 只展开一层
  })

  it('转发条目：folded 后 repostedBy 是转发者', () => {
    const bob = userResult({ id: '88', handle: 'bob', name: 'Bob', layout: 'legacy' })
    const alice = userResult({ id: '77', handle: 'alice', name: 'Alice' })
    const original = tweetResult({ id: '1', user: alice, text: 'hi' })
    const repost = tweetResult({ id: '2', user: bob, text: 'RT @alice: hi', reposted: original })
    const only = parseTimeline(searchTimeline([itemEntry('2', repost)]))
    expect(only.posts).toHaveLength(1)
    expect(only.posts[0]!.id).toBe('1')
    expect(only.posts[0]!.repostedBy?.handle).toBe('bob')
  })

  it('People 搜索：TimelineUser 条目进 users', () => {
    const json = searchTimeline([userEntry('1', userResult({ id: '1', handle: 'zed', name: 'Zed' })), cursorEntry('Bottom', 'B')])
    const out = parseTimeline(json)
    expect(out.users.map(user => user.handle)).toEqual(['zed'])
    expect(out.posts).toEqual([])
  })

  it('结构完全不认识时 entriesSeen 为 0（上层据此报 UPSTREAM_CHANGED）', () => {
    expect(parseTimeline({ data: { something: 'else' } })).toEqual({ posts: [], users: [], entriesSeen: 0, skipped: 0 })
    expect(parseTimeline(null).entriesSeen).toBe(0)
    expect(parseTimeline('garbage').entriesSeen).toBe(0)
  })

  it('条目缺关键字段只跳过那一条并计数，不抛', () => {
    const json = searchTimeline([
      itemEntry('x', { __typename: 'Tweet', rest_id: 'x', legacy: { full_text: 'no author' } }),
      itemEntry('1', tweetResult({ id: '1', user: userResult({ id: '9', handle: 'ok', name: 'ok' }), text: 'fine' })),
    ])
    const out = parseTimeline(json)
    expect(out.posts.map(post => post.id)).toEqual(['1'])
    expect(out.skipped).toBe(1)
  })
})

describe('UserTweets 与 UserByScreenName', () => {
  it('置顶条目（TimelinePinEntry）与普通条目都读，且去重', () => {
    const alice = userResult({ id: '77', handle: 'alice', name: 'Alice' })
    const pinned = tweetResult({ id: '5', user: alice, text: 'pinned' })
    const json = userTweetsTimeline([itemEntry('5', pinned), itemEntry('6', tweetResult({ id: '6', user: alice, text: 'new' }))], itemEntry('5', pinned))
    expect(parseTimeline(json).posts.map(post => post.id)).toEqual(['5', '6'])
  })

  it('2026-09 的新布局（没有 legacy）：计数在 relationship_counts / tweet_counts，简介在 profile_bio', () => {
    const profile = parseUserByScreenName(userByScreenName(userResult({ id: '33836629', handle: 'karpathy', name: 'Andrej Karpathy', followers: 4197599, verified: true, layout: 'v2' })))!
    expect(profile).toMatchObject({ id: '33836629', handle: 'karpathy', name: 'Andrej Karpathy', followers: 4197599, following: 1136, posts: 10150, verified: true, description: 'deep learning', location: 'Earth', url: 'https://example.com', protected: false })
    expect(profile.createdAt).toBe('2009-04-21T06:49:15.000Z')
    // 作者摘要走同一条路
    expect(parseAuthor(userResult({ id: '1', handle: 'v2', name: 'V2', followers: 7, layout: 'v2' }))).toMatchObject({ handle: 'v2', followers: 7 })
  })

  it('资料字段齐全；不存在的账号返回 undefined', () => {
    const profile = parseUserByScreenName(userByScreenName(userResult({ id: '77', handle: 'alice', name: 'Alice', followers: 1234, verified: true, description: 'builder' })))!
    expect(profile).toMatchObject({ id: '77', handle: 'alice', name: 'Alice', followers: 1234, following: 50, posts: 2000, verified: true, description: 'builder', location: 'Moon', url: 'https://example.com' })
    expect(profile.createdAt).toBe('2012-01-02T00:00:00.000Z')
    expect(parseUserByScreenName(userByScreenName({ __typename: 'UserUnavailable', reason: 'Suspended' }))).toBeUndefined()
    expect(parseUserByScreenName({ data: {} })).toBeUndefined()
    expect(parseProfile(undefined)).toBeUndefined()
  })
})

describe('parseTweetDetail', () => {
  it('楼主串按时间正序，其他人的回复分开；模块条目也读', () => {
    const alice = userResult({ id: '77', handle: 'alice', name: 'Alice' })
    const bob = userResult({ id: '88', handle: 'bob', name: 'Bob' })
    const root = tweetResult({ id: '100', user: alice, text: '1/', createdAt: 'Tue Sep 15 10:00:00 +0000 2026' })
    const focal = tweetResult({ id: '101', user: alice, text: '2/', conversationId: '100', inReplyTo: { id: '100', handle: 'alice' }, createdAt: 'Tue Sep 15 10:01:00 +0000 2026' })
    const third = tweetResult({ id: '102', user: alice, text: '3/', conversationId: '100', inReplyTo: { id: '101', handle: 'alice' }, createdAt: 'Tue Sep 15 10:02:00 +0000 2026' })
    const reply = tweetResult({ id: '200', user: bob, text: 'nice', conversationId: '100', inReplyTo: { id: '101', handle: 'alice' }, createdAt: 'Tue Sep 15 11:00:00 +0000 2026' })
    const json = tweetDetail([itemEntry('100', root), itemEntry('101', focal), moduleEntry('1', [third]), moduleEntry('2', [reply, tombstone]), cursorEntry('Bottom', 'B')])
    const out = parseTweetDetail(json, '101')
    expect(out.focal?.id).toBe('101')
    expect(out.thread.map(post => post.id)).toEqual(['100', '101', '102'])
    expect(out.replies.map(post => post.id)).toEqual(['200'])
    expect(out.skipped).toBe(1)
  })

  it('焦点帖不在响应里：focal 为 undefined，其余照常', () => {
    const out = parseTweetDetail(tweetDetail([cursorEntry('Bottom', 'B')]), '404')
    expect(out.focal).toBeUndefined()
    expect(out.thread).toEqual([])
    expect(out.entriesSeen).toBe(1)
  })
})

describe('媒体', () => {
  it('图片带 alt；视频取码率最高的 mp4 与封面图', () => {
    const alice = userResult({ id: '77', handle: 'alice', name: 'Alice' })
    const post = parsePost(tweetResult({ id: '5', user: alice, text: 'look https://t.co/v1 https://t.co/p1', media: [
      { short: 'https://t.co/v1', type: 'video', url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg', mp4: 'https://video.twimg.com/hi.mp4' },
      { short: 'https://t.co/p1', type: 'photo', url: 'https://pbs.twimg.com/media/p1.jpg', alt: '一根烤肠' },
    ] }))!
    expect(post.text).toBe('look')
    expect(post.media).toEqual([
      { type: 'video', url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg', videoUrl: 'https://video.twimg.com/hi.mp4' },
      { type: 'photo', url: 'https://pbs.twimg.com/media/p1.jpg', alt: '一根烤肠' },
    ])
  })
})

describe('parsePost 的边界', () => {
  it('墓碑、不可用、非对象都返回 undefined', () => {
    expect(parsePost(tombstone)).toBeUndefined()
    expect(parsePost({ __typename: 'TweetUnavailable' })).toBeUndefined()
    expect(parsePost(null)).toBeUndefined()
    expect(parsePost('x')).toBeUndefined()
  })
})
