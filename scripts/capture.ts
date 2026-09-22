/**
 * 首次部署的核对工具：不经 harness，直接起浏览器跑一次搜索 / 主页 / 帖子串，
 * 把原始 GraphQL 响应与解析结果写到一个目录里，人眼核对解析器认不认当前的 X 结构。
 *
 *   node --experimental-strip-types scripts/capture.ts --cookies ~/x-search/cookies.json --data-dir ~/x-search --out /tmp/x-capture search "zed editor"
 *   node --experimental-strip-types scripts/capture.ts ... user karpathy
 *   node --experimental-strip-types scripts/capture.ts ... thread https://x.com/karpathy/status/2081195664479068350
 *
 * 只读；一次运行只发一到两个请求。退出码非 0 表示没拿到或没解析出东西。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { XBrowser } from '../src/browser.ts'
import { XSearchConfig } from '../src/config.ts'
import { formatPosts, formatProfile } from '../src/format.ts'
import { parseTimeline, parseTweetDetail, parseUserByScreenName } from '../src/parse.ts'
import { extractPostId } from '../src/query.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const positional = process.argv.slice(2).filter((v, i, all) => !v.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--')))
const [command, subject] = positional
const cookies = arg('cookies')
const dataDir = arg('data-dir') ?? 'x-search-data'
const out = arg('out') ?? 'x-capture'
if (command === undefined || subject === undefined || cookies === undefined) {
  console.error('用法：capture.ts --cookies FILE [--data-dir DIR] [--out DIR] (search <query> | user <handle> | thread <url|id>)')
  process.exit(2)
}

const config = new XSearchConfig({ browser: { headless: arg('headed') === undefined } } as never)
mkdirSync(out, { recursive: true, mode: 0o700 })
const browser = new XBrowser({
  userDataDir: join(dataDir, 'chromium'),
  cookiesFile: cookies,
  config: config.browser,
  dumpDir: out,
  logger: { info: (m, ...a) => console.error(`[info] ${m}`, ...a), warn: (m, ...a) => console.error(`[warn] ${m}`, ...a) },
})

let code = 0
try {
  if (command === 'search') {
    const raw = await browser.search(subject, 'latest')
    const parsed = parseTimeline(raw)
    writeFileSync(join(out, 'parsed-search.json'), JSON.stringify(parsed, null, 2))
    console.log(`条目 ${parsed.entriesSeen}，帖子 ${parsed.posts.length}，账号 ${parsed.users.length}，解析失败 ${parsed.skipped}，底部游标 ${parsed.cursorBottom === undefined ? '无' : '有'}`)
    console.log(formatPosts(parsed.posts.slice(0, 5)))
    if (parsed.posts.length === 0) code = 1
  } else if (command === 'user') {
    const page = await browser.profilePage(subject.replace(/^@/, ''))
    const profile = parseUserByScreenName(page.profile)
    const tweets = page.tweets === undefined ? undefined : parseTimeline(page.tweets)
    writeFileSync(join(out, 'parsed-user.json'), JSON.stringify({ profile, tweets }, null, 2))
    console.log(profile === undefined ? '资料：解析失败' : formatProfile(profile))
    console.log(tweets === undefined ? '最近帖子：没拿到 UserTweets' : `最近帖子：条目 ${tweets.entriesSeen}，帖子 ${tweets.posts.length}，失败 ${tweets.skipped}`)
    if (profile === undefined) code = 1
  } else if (command === 'thread') {
    const id = extractPostId(subject)
    if (id === undefined) throw new Error(`认不出帖子 id：${subject}`)
    const parsed = parseTweetDetail(await browser.detail(id), id)
    writeFileSync(join(out, 'parsed-thread.json'), JSON.stringify(parsed, null, 2))
    console.log(`焦点帖 ${parsed.focal === undefined ? '没找到' : '找到'}，楼主串 ${parsed.thread.length}，回复 ${parsed.replies.length}，失败 ${parsed.skipped}`)
    if (parsed.focal === undefined) code = 1
  } else {
    throw new Error(`未知命令：${command}`)
  }
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  code = 1
} finally {
  await browser.close()
}
console.error(`原始响应与解析结果在 ${out}/`)
process.exit(code)
