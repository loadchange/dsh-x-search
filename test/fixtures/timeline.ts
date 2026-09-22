/**
 * 测试夹具：按 X 网页版 GraphQL 响应的形状手工构造。
 *
 * 形状来自公开可见的网页版响应（SearchTimeline / UserTweets / TweetDetail / UserByScreenName），
 * 覆盖新旧两种用户布局（screen_name 在 core 或 legacy）、可见性包装、转发、引用、长帖、墓碑、模块与游标。
 * 首次部署仍要用 scripts/capture.ts 抓真实响应核对——夹具只保证解析器对这些形状稳定。
 */

export function userResult(input: { id: string, handle: string, name: string, followers?: number, layout?: 'core' | 'legacy' | 'v2', verified?: boolean, description?: string }): unknown {
  if (input.layout === 'v2') {
    // 2026-09 实抓的 UserByScreenName 形状：没有 legacy，计数与简介各自成组。
    return {
      __typename: 'User',
      rest_id: input.id,
      is_blue_verified: input.verified ?? false,
      core: { created_at: 'Tue Apr 21 06:49:15 +0000 2009', name: input.name, screen_name: input.handle },
      tweet_counts: { media_tweets: 867, tweets: 10150 },
      relationship_counts: { followers: input.followers ?? 100, following: 1136 },
      profile_bio: { description: input.description ?? 'deep learning', entities: { description: {}, url: { urls: [{ url: 'https://t.co/site', expanded_url: 'https://example.com' }] } } },
      privacy: { protected: false },
      verification: { verified: false },
      location: { location: 'Earth' },
      action_counts: { favorites_count: 24865 },
    }
  }
  const legacyCommon = {
    followers_count: input.followers ?? 100,
    friends_count: 50,
    statuses_count: 2000,
    description: input.description ?? `${input.name} 的简介`,
    location: 'Moon',
    entities: { url: { urls: [{ url: 'https://t.co/site', expanded_url: 'https://example.com' }] } },
  }
  if (input.layout === 'legacy') {
    return {
      __typename: 'User',
      rest_id: input.id,
      is_blue_verified: input.verified ?? false,
      legacy: { ...legacyCommon, screen_name: input.handle, name: input.name, created_at: 'Mon Jan 02 00:00:00 +0000 2012' },
    }
  }
  return {
    __typename: 'User',
    rest_id: input.id,
    is_blue_verified: input.verified ?? false,
    core: { screen_name: input.handle, name: input.name, created_at: 'Mon Jan 02 00:00:00 +0000 2012' },
    legacy: legacyCommon,
  }
}

export interface TweetInput {
  id: string
  user: unknown
  text: string
  createdAt?: string
  likes?: number
  reposts?: number
  replies?: number
  quotes?: number
  views?: string
  lang?: string
  conversationId?: string
  inReplyTo?: { id: string, handle: string }
  urls?: { short: string, expanded: string }[]
  media?: { short: string, type: string, url?: string, alt?: string, mp4?: string }[]
  noteText?: string
  quoted?: unknown
  reposted?: unknown
  wrapVisibility?: boolean
}

export function tweetResult(input: TweetInput): unknown {
  const legacy: Record<string, unknown> = {
    id_str: input.id,
    full_text: input.text,
    created_at: input.createdAt ?? 'Tue Sep 15 10:20:30 +0000 2026',
    favorite_count: input.likes ?? 0,
    retweet_count: input.reposts ?? 0,
    reply_count: input.replies ?? 0,
    quote_count: input.quotes ?? 0,
    bookmark_count: 1,
    lang: input.lang ?? 'en',
    conversation_id_str: input.conversationId ?? input.id,
    entities: { urls: (input.urls ?? []).map(u => ({ url: u.short, expanded_url: u.expanded })), hashtags: [] },
  }
  if (input.inReplyTo !== undefined) {
    legacy['in_reply_to_status_id_str'] = input.inReplyTo.id
    legacy['in_reply_to_screen_name'] = input.inReplyTo.handle
  }
  if (input.media !== undefined) {
    legacy['extended_entities'] = { media: input.media.map(m => ({
      url: m.short,
      type: m.type,
      media_url_https: m.url ?? `https://pbs.twimg.com/media/${m.short.split('/').pop()}.jpg`,
      ...m.alt === undefined ? {} : { ext_alt_text: m.alt },
      ...m.mp4 === undefined ? {} : { video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8' }, { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/low.mp4' }, { content_type: 'video/mp4', bitrate: 2176000, url: m.mp4 }] } },
    })) }
  }
  if (input.reposted !== undefined) legacy['retweeted_status_result'] = { result: input.reposted }
  const tweet: Record<string, unknown> = {
    __typename: 'Tweet',
    rest_id: input.id,
    core: { user_results: { result: input.user } },
    legacy,
    ...input.views === undefined ? {} : { views: { count: input.views, state: 'EnabledWithCount' } },
    ...input.noteText === undefined ? {} : { note_tweet: { is_expandable: true, note_tweet_results: { result: { id: `note-${input.id}`, text: input.noteText, entity_set: { urls: [], hashtags: [] } } } } },
    ...input.quoted === undefined ? {} : { quoted_status_result: { result: input.quoted } },
  }
  return input.wrapVisibility === true ? { __typename: 'TweetWithVisibilityResults', tweet, limitedActionResults: {} } : tweet
}

export const tombstone = { __typename: 'TweetTombstone', tombstone: { text: { text: 'This Post was deleted.' } } }

export function itemEntry(id: string, tweet: unknown): unknown {
  return { entryId: `tweet-${id}`, sortIndex: id, content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: tweet }, tweetDisplayType: 'Tweet' } } }
}

export function userEntry(id: string, user: unknown): unknown {
  return { entryId: `user-${id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: user }, userDisplayType: 'User' } } }
}

export function moduleEntry(id: string, tweets: unknown[]): unknown {
  return { entryId: `conversationthread-${id}`, content: { entryType: 'TimelineTimelineModule', items: tweets.map((tweet, i) => ({ entryId: `conversationthread-${id}-tweet-${i}`, item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweet } } } })) } }
}

export function cursorEntry(type: 'Top' | 'Bottom', value: string): unknown {
  return { entryId: `cursor-${type.toLowerCase()}-1`, content: { entryType: 'TimelineTimelineCursor', cursorType: type, value } }
}

export function searchTimeline(entries: unknown[]): unknown {
  return { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } }
}

export function userTweetsTimeline(entries: unknown[], pinned?: unknown): unknown {
  return { data: { user: { result: { __typename: 'User', timeline: { timeline: { instructions: [
    ...pinned === undefined ? [] : [{ type: 'TimelinePinEntry', entry: pinned }],
    { type: 'TimelineAddEntries', entries },
  ] } } } } } }
}

export function tweetDetail(entries: unknown[]): unknown {
  return { data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } }
}

export function userByScreenName(user: unknown): unknown {
  return { data: { user: { result: user } } }
}

/** 一份「像真的」搜索响应：4 条帖子（含转发、引用、长帖、可见性包装）、1 个墓碑、2 个游标。 */
export function sampleSearch(): { json: unknown, ids: string[] } {
  const alice = userResult({ id: '77', handle: 'alice', name: 'Alice', followers: 1234, verified: true })
  const bob = userResult({ id: '88', handle: 'bob', name: 'Bob', layout: 'legacy' })
  const original = tweetResult({
    id: '1001', user: alice, text: 'Loving the new Zed release https://t.co/abc &amp; more', likes: 42, reposts: 7, replies: 3, quotes: 1, views: '5000',
    urls: [{ short: 'https://t.co/abc', expanded: 'https://zed.dev/blog' }],
  })
  const repost = tweetResult({ id: '1002', user: bob, text: 'RT @alice: Loving the new Zed release', reposted: original, wrapVisibility: true, createdAt: 'Tue Sep 15 11:00:00 +0000 2026' })
  const reply = tweetResult({
    id: '1003', user: bob, text: '@alice short text https://t.co/pic', inReplyTo: { id: '1001', handle: 'alice' }, conversationId: '1001',
    createdAt: 'Tue Sep 15 12:00:00 +0000 2026', likes: 5, media: [{ short: 'https://t.co/pic', type: 'photo' }],
    noteText: '@alice 这是一条很长的帖子，长到 X 把它放进了 note_tweet 里。'.repeat(3), quoted: original,
  })
  const plain = tweetResult({ id: '1004', user: alice, text: 'Nothing special', createdAt: 'Mon Sep 14 09:00:00 +0000 2026', likes: 99 })
  const json = searchTimeline([
    itemEntry('1001', original),
    itemEntry('1002', repost),
    itemEntry('1003', reply),
    itemEntry('1005', tombstone),
    itemEntry('1004', plain),
    cursorEntry('Top', 'TOP'),
    cursorEntry('Bottom', 'BOTTOM'),
  ])
  return { json, ids: ['1001', '1003', '1004'] }
}
