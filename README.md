# dsh-x-search

Natural-language X (Twitter) search with **your own X account**, as a DeepSeek Harness (dsh) plugin.
One question in, a cited report with structured posts out. Images are read and "what does this post mean" is answered on the server.

[中文说明](README.zh-CN.md)

## How it works

- A persistent headless Chromium is logged in with two cookies copied from your browser (`auth_token`, `ct0`). No password on the server, no login flow.
- It opens x.com pages and reads the GraphQL responses the page itself receives (`SearchTimeline`, `UserByScreenName`, `UserOriginalsTimeline`, `TweetDetail`). No DOM parsing.
- The host's model turns your request into X search operators, writes the report and answers questions; a vision model reads the images first. Without a model you still get the posts, as raw citations.
- Rate limiting (40 per 15 min, 600 per day, 1.5 s apart) and fail-closed on session loss protect the account.

## Client: the `dsh-x` skill

```bash
npx skills@latest add loadchange/dsh-x-search                                   # installs skills/dsh-x into your agent
S=<skill-dir>/scripts/dsh_x.py
python3 $S config --url https://x-search.example.com --token <token>            # writes ~/.config/dsh-x/config.json (0600)
python3 $S check
python3 $S x "what are developers saying about the Zed editor this week"
python3 $S ask https://x.com/<handle>/status/<id> "what does this post mean?"
```

Commands: `x`, `user`, `thread`, `ask`, `check`, `config`. Flags mirror xAI `x_search`: `--handle` / `--exclude-handle` (≤ 20), `--since` / `--until`, `--sort`, `--lang`, `--limit`, plus `--session` for follow-ups, `--json`, `--raw`.
Details in [skills/dsh-x/SKILL.md](skills/dsh-x/SKILL.md). Claude Code can also install it as a plugin: `claude plugin marketplace add loadchange/dsh-x-search && claude plugin install dsh-x@dsh-x-search`.

## Server

One dsh profile + one systemd unit, HTTP on `127.0.0.1:31890`, exposed through a Cloudflare Tunnel with a Bearer token. See [deploy/README.md](deploy/README.md).

## HTTP API

| Route | Body |
|---|---|
| `POST /api/search` | `{request, since?, until?, sort?, lang?, limit?, allowedHandles?, excludedHandles?, excludeReplies?, replyLang?, rules?, raw?, queries?, question?}` |
| `POST /api/user` | `{request, replyLang?, raw?, question?}` |
| `POST /api/thread` | `{post, replyLang?, raw?, question?}` — with `question` the response adds `original` (post text + image descriptions) |
| `POST /api/followup` | `{sessionId, request, replyLang?}` |
| `GET /api/status` · `GET /healthz` | — |

Response and error shapes: [skills/dsh-x/references/api.md](skills/dsh-x/references/api.md). Agents in the same process get the same as tools `x_search`, `x_user`, `x_thread`, `x_followup`.

## Development

```bash
npm run check && npx vitest run      # typecheck + tests; no network, no browser
npm pack                             # deploy tarball
node --experimental-strip-types scripts/capture.ts --cookies FILE --out DIR search "zed"   # capture live responses when X changes shape
```

## Know the risks

- Programmatic use of a web session violates X's terms. Use a dedicated account.
- Data-center IPs draw verification prompts. When the session dies the plugin stops (`SESSION_EXPIRED`) until you re-import cookies.
- X changes its responses now and then. `UPSTREAM_CHANGED` means the parser needs a fixture update, not that your query was wrong.

MIT
