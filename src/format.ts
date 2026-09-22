/**
 * 原始引用格式：不经模型、直接把帖子排成可核对的引用块。
 *
 * 格式与 grok skill 的规则一致：`@handle - YYYY-MM-DD - 永久链接`，正文原样引述，
 * 互动数跟在它描述的那条帖子后面。调用方（另一个 agent）拿到这个就能自己综合。
 * @module
 */
import type { Post, Profile } from './parse.ts'

/** ISO → YYYY-MM-DD；空串原样返回。 */
export function dateOnly(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso
}

/** 一行引用头。 */
export function citation(post: Post): string {
  return `@${post.author.handle} - ${dateOnly(post.createdAt) || '日期未知'} - ${post.url}`
}

function metricsLine(post: Post): string {
  const m = post.metrics
  const parts = [`赞 ${m.likes}`, `转 ${m.reposts}`, `回复 ${m.replies}`, `引用 ${m.quotes}`]
  if (m.views !== undefined) parts.push(`浏览 ${m.views}`)
  return parts.join(' · ')
}

/**
 * 一条帖子的引用块。
 * @param post - 帖子。
 * @param indent - 缩进（引用帖用）。
 * @returns 多行文本。
 */
export function formatPost(post: Post, indent = ''): string {
  const lines: string[] = []
  const who = post.repostedBy === undefined ? '' : `（由 @${post.repostedBy.handle} 转发）`
  lines.push(`${indent}${citation(post)}${who}`)
  const meta: string[] = [metricsLine(post)]
  if (post.author.followers !== undefined) meta.push(`作者粉丝 ${post.author.followers}`)
  if (post.inReplyToHandle !== undefined) meta.push(`回复 @${post.inReplyToHandle}`)
  if (post.media !== undefined && post.media.length > 0) meta.push(`媒体 ${post.media.map(m => m.type).join('/')}`)
  lines.push(`${indent}  ${meta.join(' · ')}`)
  for (const line of post.text.split('\n')) lines.push(`${indent}  > ${line}`)
  for (const [i, m] of (post.media ?? []).entries()) {
    const label = m.type === 'photo' ? '图片' : m.type === 'video' ? '视频封面' : '动图'
    if (m.description !== undefined) lines.push(`${indent}  [${label} ${i + 1}] ${m.description.replace(/\n+/g, ' ')}`)
    else if (m.alt !== undefined) lines.push(`${indent}  [${label} ${i + 1} 替代文字] ${m.alt.replace(/\n+/g, ' ')}`)
    else lines.push(`${indent}  [${label} ${i + 1}] ${m.url}（未读图）`)
  }
  if (post.quoted !== undefined) {
    lines.push(`${indent}  引用：`)
    lines.push(formatPost(post.quoted, `${indent}    `))
  }
  return lines.join('\n')
}

/**
 * 一组帖子。
 * @param posts - 帖子。
 * @param heading - 标题行。
 * @returns 文本；没有帖子时说明为空。
 */
export function formatPosts(posts: readonly Post[], heading = ''): string {
  const head = heading.length > 0 ? [heading, ''] : []
  if (posts.length === 0) return [...head, '（搜索没有返回任何帖子——这是 X 上的事实，不是格式问题。）'].join('\n')
  return [...head, ...posts.map((post, i) => `${i + 1}. ${formatPost(post).replace(/\n/g, '\n   ')}`)].join('\n\n')
}

/** 账号资料。 */
export function formatProfile(profile: Profile): string {
  const lines = [
    `@${profile.handle} — ${profile.name}${profile.verified === true ? '（已认证）' : ''} — https://x.com/${profile.handle}`,
    `  粉丝 ${profile.followers} · 关注 ${profile.following} · 帖子 ${profile.posts}`
      + (profile.createdAt === undefined ? '' : ` · 注册于 ${dateOnly(profile.createdAt)}`)
      + (profile.location === undefined ? '' : ` · ${profile.location}`)
      + (profile.protected === true ? ' · 受保护账号' : ''),
  ]
  if (profile.description.length > 0) lines.push(`  简介：${profile.description.replace(/\n/g, ' ')}`)
  if (profile.url !== undefined) lines.push(`  网址：${profile.url}`)
  return lines.join('\n')
}
