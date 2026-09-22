/**
 * 解析 X 网页版自己的 GraphQL 时间线响应（SearchTimeline / UserTweets / TweetDetail / UserByScreenName）。
 *
 * 这些响应是浏览器本来就会收到的东西，本插件只是把它读出来。结构以 X 网页版当前的形态为准：
 * `data.*.instructions[]` → `entries[]` → `content.itemContent.tweet_results.result`。
 * X 会改结构，所以这里的每一步都是**宽松读取**：字段缺了就跳过那一条并计数，绝不抛错；
 * 一整份响应解析出 0 条而原文不为空时，由上层报 `UPSTREAM_CHANGED`。
 *
 * 首次部署必须用 `scripts/capture.ts` 抓一份真实响应核对本文件（见 deploy/README.md）。
 * @module
 */

export interface PostMetrics {
  likes: number
  reposts: number
  replies: number
  quotes: number
  bookmarks?: number | undefined
  views?: number | undefined
}

export interface PostAuthor {
  id: string
  handle: string
  name: string
  followers?: number | undefined
  verified?: boolean | undefined
}

/** 帖子里的一张图或一段视频。`description` 由服务端读图后补上（客户端不必再自己抓图）。 */
export interface PostMedia {
  /** photo / video / animated_gif。 */
  type: string
  /** 图片本体（视频则是封面图）。 */
  url: string
  /** 作者填的替代文字。 */
  alt?: string | undefined
  /** 视频：码率最高的 mp4。 */
  videoUrl?: string | undefined
  /** 服务端读图得到的描述与文字转录；没读时不存在。 */
  description?: string | undefined
}

export interface Post {
  id: string
  url: string
  /** 全文：长帖取 note_tweet，t.co 短链已展开成原链接。 */
  text: string
  /** ISO 8601；解析不出时为空串。 */
  createdAt: string
  author: PostAuthor
  lang?: string | undefined
  metrics: PostMetrics
  conversationId?: string | undefined
  inReplyToId?: string | undefined
  inReplyToHandle?: string | undefined
  quoted?: Post | undefined
  /** 这是一条转发时：转发者。帖子本身的字段是被转发的原帖。 */
  repostedBy?: PostAuthor | undefined
  /** 媒体：图片、视频封面与作者替代文字；服务端读图后带 description。 */
  media?: PostMedia[] | undefined
  /** 帖子里的外链（已展开）。 */
  links?: string[] | undefined
}

export interface Profile {
  id: string
  handle: string
  name: string
  description: string
  followers: number
  following: number
  posts: number
  createdAt?: string | undefined
  verified?: boolean | undefined
  location?: string | undefined
  url?: string | undefined
  protected?: boolean | undefined
}

export interface ParsedTimeline {
  posts: Post[]
  /** People 搜索或用户模块里的账号。 */
  users: Profile[]
  cursorBottom?: string | undefined
  /** 看到的条目总数（含游标、模块）。用来区分「响应本来就空」和「结构变了」。 */
  entriesSeen: number
  /** 认出是帖子但解析失败的条目数。 */
  skipped: number
}

export interface ParsedThread {
  focal?: Post | undefined
  /** 楼主的连续帖（含被回复的祖先），按时间正序。 */
  thread: Post[]
  /** 其他人的回复与引用，按响应顺序。 */
  replies: Post[]
  entriesSeen: number
  skipped: number
}

type Rec = Record<string, unknown>

function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

/**
 * X 的日期格式 `Wed Oct 10 20:19:24 +0000 2018` → ISO。
 * @param value - 原串。
 * @returns ISO 8601；认不出时空串。
 */
export function parseTwitterDate(value: string | undefined): string {
  if (value === undefined) return ''
  const m = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(value)
  if (m !== null) {
    const month = MONTHS[m[1]!]
    if (month !== undefined) {
      const sign = m[6] === '-' ? -1 : 1
      const offsetMin = sign * (Number(m[7]) * 60 + Number(m[8]))
      const utc = Date.UTC(Number(m[9]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offsetMin * 60_000
      return new Date(utc).toISOString()
    }
  }
  const fallback = Date.parse(value)
  return Number.isNaN(fallback) ? '' : new Date(fallback).toISOString()
}

/** 去掉 TweetWithVisibilityResults 这层壳；墓碑与不可用的帖子返回 undefined。 */
function unwrapTweet(result: unknown): Rec | undefined {
  const r = rec(result)
  if (r === undefined) return undefined
  const typename = str(r['__typename'])
  if (typename === 'TweetWithVisibilityResults') return unwrapTweet(r['tweet'])
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') return undefined
  if (r['legacy'] === undefined && r['rest_id'] === undefined) return undefined
  return r
}

function unwrapUser(result: unknown): Rec | undefined {
  const r = rec(result)
  if (r === undefined) return undefined
  const typename = str(r['__typename'])
  if (typename === 'UserUnavailable') return undefined
  if (r['legacy'] === undefined && r['core'] === undefined && r['rest_id'] === undefined) return undefined
  return r
}

/**
 * 从 user_results.result 读作者。新旧两种布局都认：screen_name/name 早先在 legacy，后来搬到了 core。
 * @param result - `user_results.result`。
 * @returns 作者；缺关键字段时 undefined。
 */
export function parseAuthor(result: unknown): PostAuthor | undefined {
  const u = unwrapUser(result)
  if (u === undefined) return undefined
  const legacy = rec(u['legacy']) ?? {}
  const core = rec(u['core']) ?? {}
  const handle = str(core['screen_name']) ?? str(legacy['screen_name'])
  const id = str(u['rest_id']) ?? str(legacy['id_str'])
  if (handle === undefined || id === undefined) return undefined
  const verified = bool(u['is_blue_verified']) ?? bool(rec(u['verification'])?.['verified']) ?? bool(legacy['verified'])
  // 2026-09 起 UserByScreenName 没有 legacy 了：计数在 relationship_counts / tweet_counts，简介在 profile_bio。
  const followers = num(rec(u['relationship_counts'])?.['followers']) ?? num(legacy['followers_count'])
  return {
    id,
    handle,
    name: str(core['name']) ?? str(legacy['name']) ?? handle,
    ...followers === undefined ? {} : { followers },
    ...verified === undefined ? {} : { verified },
  }
}

/**
 * 完整资料（UserByScreenName / People 搜索条目）。
 * @param result - `user.result` 或 `user_results.result`。
 * @returns 资料；缺关键字段时 undefined。
 */
export function parseProfile(result: unknown): Profile | undefined {
  const author = parseAuthor(result)
  const u = unwrapUser(result)
  if (author === undefined || u === undefined) return undefined
  const legacy = rec(u['legacy']) ?? {}
  const core = rec(u['core']) ?? {}
  const relationship = rec(u['relationship_counts']) ?? {}
  const tweetCounts = rec(u['tweet_counts']) ?? {}
  const bio = rec(u['profile_bio']) ?? {}
  const urlEntities = arr(rec(rec(legacy['entities'])?.['url'])?.['urls'])
  const bioUrlEntities = arr(rec(rec(bio['entities'])?.['url'])?.['urls'])
  const website = str(rec(urlEntities[0])?.['expanded_url']) ?? str(rec(bioUrlEntities[0])?.['expanded_url']) ?? str(legacy['url'])
  const location = str(rec(u['location'])?.['location']) ?? str(legacy['location'])
  const createdAt = parseTwitterDate(str(core['created_at']) ?? str(legacy['created_at']))
  const isProtected = bool(rec(u['privacy'])?.['protected']) ?? bool(legacy['protected'])
  return {
    id: author.id,
    handle: author.handle,
    name: author.name,
    description: str(bio['description']) ?? str(legacy['description']) ?? '',
    followers: num(relationship['followers']) ?? num(legacy['followers_count']) ?? 0,
    following: num(relationship['following']) ?? num(legacy['friends_count']) ?? 0,
    posts: num(tweetCounts['tweets']) ?? num(legacy['statuses_count']) ?? 0,
    ...createdAt.length === 0 ? {} : { createdAt },
    ...author.verified === undefined ? {} : { verified: author.verified },
    ...location === undefined ? {} : { location },
    ...website === undefined ? {} : { url: website },
    ...isProtected === undefined ? {} : { protected: isProtected },
  }
}

/** 视频取码率最高的 mp4。 */
function bestVideo(m: Rec): string | undefined {
  const variants = arr(rec(m['video_info'])?.['variants'])
  let best: { bitrate: number, url: string } | undefined
  for (const v of variants) {
    const r = rec(v)
    const url = str(r?.['url'])
    if (url === undefined || str(r?.['content_type']) !== 'video/mp4') continue
    const bitrate = num(r?.['bitrate']) ?? 0
    if (best === undefined || bitrate > best.bitrate) best = { bitrate, url }
  }
  return best?.url
}

/** 把正文里的 t.co 短链换成原链接，并去掉挂在末尾的媒体短链。 */
function expandText(text: string, legacy: Rec): { text: string, links: string[], media: PostMedia[] } {
  const entities = rec(legacy['entities']) ?? {}
  const extended = rec(legacy['extended_entities']) ?? {}
  let out = text
  const links: string[] = []
  for (const item of arr(entities['urls'])) {
    const u = rec(item)
    const short = str(u?.['url'])
    const expanded = str(u?.['expanded_url'])
    if (short === undefined || expanded === undefined) continue
    out = out.split(short).join(expanded)
    if (!/^https?:\/\/t\.co\//.test(expanded)) links.push(expanded)
  }
  const media: PostMedia[] = []
  for (const item of arr(extended['media']).length > 0 ? arr(extended['media']) : arr(entities['media'])) {
    const m = rec(item)
    if (m === undefined) continue
    const short = str(m['url'])
    const type = str(m['type'])
    const url = str(m['media_url_https']) ?? str(m['media_url'])
    if (type !== undefined && url !== undefined) {
      const alt = str(m['ext_alt_text']) ?? str(m['alt_text'])
      const videoUrl = type === 'video' || type === 'animated_gif' ? bestVideo(m) : undefined
      media.push({ type, url, ...alt === undefined ? {} : { alt }, ...videoUrl === undefined ? {} : { videoUrl } })
    }
    if (short !== undefined) out = out.split(short).join('').trimEnd()
  }
  // X 把 HTML 实体留在 full_text 里。
  out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  return { text: out.trim(), links, media }
}

/**
 * 一条 `tweet_results.result` → Post。转发条目返回被转发的原帖并标注转发者；引用帖只展开一层。
 * @param result - `tweet_results.result`。
 * @param depth - 内部：嵌套深度。
 * @returns 帖子；解析不出关键字段时 undefined。
 */
export function parsePost(result: unknown, depth = 0): Post | undefined {
  const t = unwrapTweet(result)
  if (t === undefined) return undefined
  const legacy = rec(t['legacy'])
  if (legacy === undefined) return undefined
  const author = parseAuthor(rec(rec(t['core'])?.['user_results'])?.['result'])

  const reposted = rec(rec(legacy['retweeted_status_result'])?.['result'])
  if (reposted !== undefined && depth === 0) {
    const inner = parsePost(reposted, depth + 1)
    if (inner !== undefined) return { ...inner, ...author === undefined ? {} : { repostedBy: author } }
  }

  const id = str(t['rest_id']) ?? str(legacy['id_str'])
  if (id === undefined || author === undefined) return undefined

  const noteText = str(rec(rec(rec(t['note_tweet'])?.['note_tweet_results'])?.['result'])?.['text'])
  const noteLegacy = rec(rec(rec(t['note_tweet'])?.['note_tweet_results'])?.['result'])
  // 长帖的实体在 note_tweet 自己的 entity_set 里；短帖在 legacy.entities。
  const entitySource: Rec = noteText !== undefined && noteLegacy !== undefined && rec(noteLegacy['entity_set']) !== undefined
    ? { entities: noteLegacy['entity_set'], extended_entities: legacy['extended_entities'] }
    : legacy
  const expanded = expandText(noteText ?? str(legacy['full_text']) ?? '', entitySource)

  const views = num(rec(t['views'])?.['count'])
  const bookmarks = num(legacy['bookmark_count'])
  const quoted = depth === 0 ? parsePost(rec(t['quoted_status_result'])?.['result'], depth + 1) : undefined
  const lang = str(legacy['lang'])
  const conversationId = str(legacy['conversation_id_str'])
  const inReplyToId = str(legacy['in_reply_to_status_id_str'])
  const inReplyToHandle = str(legacy['in_reply_to_screen_name'])

  return {
    id,
    url: `https://x.com/${author.handle}/status/${id}`,
    text: expanded.text,
    createdAt: parseTwitterDate(str(legacy['created_at'])),
    author,
    ...lang === undefined ? {} : { lang },
    metrics: {
      likes: num(legacy['favorite_count']) ?? 0,
      reposts: num(legacy['retweet_count']) ?? 0,
      replies: num(legacy['reply_count']) ?? 0,
      quotes: num(legacy['quote_count']) ?? 0,
      ...bookmarks === undefined ? {} : { bookmarks },
      ...views === undefined ? {} : { views },
    },
    ...conversationId === undefined ? {} : { conversationId },
    ...inReplyToId === undefined ? {} : { inReplyToId },
    ...inReplyToHandle === undefined ? {} : { inReplyToHandle },
    ...quoted === undefined ? {} : { quoted },
    ...expanded.media.length === 0 ? {} : { media: expanded.media },
    ...expanded.links.length === 0 ? {} : { links: expanded.links },
  }
}

/** 递归找出响应里所有 `instructions` 数组（SearchTimeline、UserTweets、TweetDetail 各在不同深度）。 */
function collectInstructions(root: unknown, depth = 0, out: unknown[][] = []): unknown[][] {
  if (depth > 8) return out
  const r = rec(root)
  if (r === undefined) return out
  for (const [key, value] of Object.entries(r)) {
    if (key === 'instructions' && Array.isArray(value)) out.push(value)
    else if (typeof value === 'object' && value !== null) collectInstructions(value, depth + 1, out)
  }
  return out
}

function entriesOf(instruction: unknown): unknown[] {
  const ins = rec(instruction)
  if (ins === undefined) return []
  const type = str(ins['type'])
  if (type === 'TimelineAddEntries') return arr(ins['entries'])
  if (type === 'TimelineReplaceEntry' || type === 'TimelinePinEntry') return ins['entry'] === undefined ? [] : [ins['entry']]
  if (type === 'TimelineAddToModule') return arr(ins['moduleItems']).map(item => ({ content: { entryType: 'TimelineTimelineItem', itemContent: rec(rec(item)?.['item'])?.['itemContent'] } }))
  return []
}

/**
 * 解析一份时间线响应（搜索、用户主页、会话详情都是这一种形状）。
 * @param json - 响应 JSON。
 * @returns 帖子、账号、底部游标与计数。
 */
export function parseTimeline(json: unknown): ParsedTimeline {
  const posts: Post[] = []
  const users: Profile[] = []
  const seenPosts = new Set<string>()
  const seenUsers = new Set<string>()
  let cursorBottom: string | undefined
  let entriesSeen = 0
  let skipped = 0

  const takeItem = (itemContent: unknown): void => {
    const ic = rec(itemContent)
    if (ic === undefined) return
    const itemType = str(ic['itemType']) ?? str(ic['__typename'])
    if (itemType === 'TimelineTweet') {
      const post = parsePost(rec(ic['tweet_results'])?.['result'])
      if (post === undefined) { skipped += 1; return }
      if (seenPosts.has(post.id)) return
      seenPosts.add(post.id)
      posts.push(post)
    } else if (itemType === 'TimelineUser') {
      const profile = parseProfile(rec(ic['user_results'])?.['result'])
      if (profile === undefined) { skipped += 1; return }
      if (seenUsers.has(profile.id)) return
      seenUsers.add(profile.id)
      users.push(profile)
    }
  }

  for (const instructions of collectInstructions(json)) {
    for (const instruction of instructions) {
      for (const entry of entriesOf(instruction)) {
        entriesSeen += 1
        const content = rec(rec(entry)?.['content'])
        if (content === undefined) continue
        const entryType = str(content['entryType']) ?? str(content['__typename'])
        if (entryType === 'TimelineTimelineItem') takeItem(content['itemContent'])
        else if (entryType === 'TimelineTimelineModule') {
          for (const item of arr(content['items'])) takeItem(rec(rec(item)?.['item'])?.['itemContent'])
        } else if (entryType === 'TimelineTimelineCursor') {
          if (str(content['cursorType']) === 'Bottom') cursorBottom = str(content['value'])
        }
      }
    }
  }
  return { posts, users, ...cursorBottom === undefined ? {} : { cursorBottom }, entriesSeen, skipped }
}

/**
 * UserByScreenName 响应 → 资料。
 * @param json - 响应 JSON。
 * @returns 资料；账号不存在或被停用时 undefined。
 */
export function parseUserByScreenName(json: unknown): Profile | undefined {
  return parseProfile(rec(rec(rec(json)?.['data'])?.['user'])?.['result'])
}

/**
 * TweetDetail 响应 → 楼主串 + 回复。
 * @param json - 响应 JSON。
 * @param focalId - 请求的那条帖子 id。
 * @returns 焦点帖、楼主连续帖、其他回复。
 */
export function parseTweetDetail(json: unknown, focalId: string): ParsedThread {
  const tl = parseTimeline(json)
  const focal = tl.posts.find(post => post.id === focalId)
  const conversationId = focal?.conversationId ?? focalId
  const thread = focal === undefined
    ? []
    : tl.posts
      .filter(post => post.author.handle === focal.author.handle && (post.conversationId === conversationId || post.id === focalId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const inThread = new Set(thread.map(post => post.id))
  const replies = tl.posts.filter(post => !inThread.has(post.id))
  return { ...focal === undefined ? {} : { focal }, thread, replies, entriesSeen: tl.entriesSeen, skipped: tl.skipped }
}
