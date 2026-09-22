# dsh-x-search

用**自己的 X 账号**做自然语言 X（Twitter）搜索的 DeepSeek Harness（dsh）插件。
一句话进去，带引用的报告和结构化帖子出来。读图和「这个帖子什么意思」都在服务端完成。

[English](README.md)

## 它怎么工作

- 一个持久化的无头 Chromium，用从你浏览器抄来的两个 cookie（`auth_token`、`ct0`）保持登录。服务器上没有密码，不走登录流程。
- 打开 x.com 页面，读页面自己收到的 GraphQL 响应（`SearchTimeline`、`UserByScreenName`、`UserOriginalsTimeline`、`TweetDetail`）。不解析 DOM。
- 宿主的模型把请求变成 X 搜索算符、写报告、回答问题；看图模型先把图片读掉。没有模型也能拿到帖子，只是退化成原始引用。
- 限流（15 分钟 40 次、每日 600 次、间隔 1.5 秒）和登录失效即停是账号的安全阀。

## 客户端：`dsh-x` skill

```bash
npx skills@latest add loadchange/dsh-x-search                                   # 把 skills/dsh-x 装进你的 agent
S=<skill 目录>/scripts/dsh_x.py
python3 $S config --url https://x-search.example.com --token <token>            # 写 ~/.config/dsh-x/config.json（0600）
python3 $S check
python3 $S x "what are developers saying about the Zed editor this week"
python3 $S ask https://x.com/<handle>/status/<id> "这个帖子什么意思？"
```

命令：`x`、`user`、`thread`、`ask`、`check`、`config`。旗标对齐 xAI `x_search`：`--handle` / `--exclude-handle`（≤ 20）、`--since` / `--until`、`--sort`、`--lang`、`--limit`，另有 `--session` 追问、`--json`、`--raw`。
细节见 [skills/dsh-x/SKILL.md](skills/dsh-x/SKILL.md)。Claude Code 也可以当插件装：`claude plugin marketplace add loadchange/dsh-x-search && claude plugin install dsh-x@dsh-x-search`。

## 服务端

一个 dsh profile + 一个 systemd 单元，HTTP 只绑 `127.0.0.1:31890`，经 Cloudflare Tunnel + Bearer 令牌对外。见 [deploy/README.md](deploy/README.md)。

## HTTP 接口

| 路由 | 请求体 |
|---|---|
| `POST /api/search` | `{request, since?, until?, sort?, lang?, limit?, allowedHandles?, excludedHandles?, excludeReplies?, replyLang?, rules?, raw?, queries?, question?}` |
| `POST /api/user` | `{request, replyLang?, raw?, question?}` |
| `POST /api/thread` | `{post, replyLang?, raw?, question?}`，带 `question` 时响应多一个 `original`（正文 + 图片描述） |
| `POST /api/followup` | `{sessionId, request, replyLang?}` |
| `GET /api/status` · `GET /healthz` | — |

响应与错误码见 [skills/dsh-x/references/api.md](skills/dsh-x/references/api.md)。同进程的 agent 还能直接用工具 `x_search`、`x_user`、`x_thread`、`x_followup`。

## 开发

```bash
npm run check && npx vitest run      # 类型检查 + 测试，不联网、不起浏览器
npm pack                             # 部署用的 tarball
node --experimental-strip-types scripts/capture.ts --cookies FILE --out DIR search "zed"   # X 改结构时抓真实响应
```

## 风险

- 用网页会话做程序化读取违反 X 的使用条款。请用专门的账号。
- 数据中心 IP 容易触发验证。登录态一失效插件就停（`SESSION_EXPIRED`），重新导入 cookie 才继续。
- X 会时不时改响应结构。`UPSTREAM_CHANGED` 表示解析器要补夹具，不是你的查询有问题。

MIT
