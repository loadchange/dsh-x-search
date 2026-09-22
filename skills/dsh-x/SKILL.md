---
name: dsh-x
description: Search X (Twitter) through your own dsh-x-search endpoint — posts, topics, sentiment, an account and its recent posts, or one post's full thread — returned as a cited report with structured posts. Use for anything on X; also on "查一下 X", "推特上", "ask dsh-x". No Grok subscription involved.
---

# dsh-x

Client for a [dsh-x-search](https://github.com/loadchange/dsh-x-search) instance: it searches X with the owner's account and writes cited reports with its host's model. X only; use another skill for web search, page fetching or image generation.

## Setup

```bash
python3 <skill-path>/scripts/dsh_x.py config --url https://x-search.example.com --token <token>   # writes ~/.config/dsh-x/config.json (0600)
python3 <skill-path>/scripts/dsh_x.py check                                                       # endpoint, session, quota
```

Config is the file `~/.config/dsh-x/config.json` (`{"url", "token", "timeoutSec"}`; `DSH_X_CONFIG=<path>` overrides), never environment variables. Python 3.9+, stdlib only.

## Commands

| Command | Use for |
|---|---|
| `x "<request>"` | **The main one.** Any X question: posts, topics, sentiment, who said what |
| `user "<handle or who>"` | Profile + recent posts; a description is resolved through People search |
| `thread <url\|id>` | One post's full text, the author's thread, the replies |
| `ask <url\|id> <question…>` | **"What does this post mean?"** The server reads the post, its thread and its images, answers directly and returns the original text with image descriptions |
| `x "<question>" --session <id>` | Follow-up over the previous search's posts; no new search |
| `check` · `config` | Endpoint status · write/show the config file |

```bash
S=<skill-path>/scripts/dsh_x.py
python3 $S x "what are developers saying about the Zed editor this week" --since 2026-09-15 --reply-lang Chinese
python3 $S x "reactions to the Figma IPO" --handle bloomberg --handle reuters --raw
python3 $S user karpathy
python3 $S thread https://x.com/karpathy/status/2081195664479068350 --json
python3 $S ask https://x.com/someone/status/1234567890123456789 what does this post mean?
```

Report on stdout; timing, session id, warnings and the queries run on stderr. `--json` gives `answer`, `posts[]`, `queries`, `warnings`, `session_id`.

## Flags

`--since` / `--until YYYY-MM-DD` · `--sort latest|top` · `--lang XX` · `--limit N` (default 30, max 80) · `--handle H` (repeat, ≤ 20) · `--exclude-handle H` (repeat, ≤ 20, not with `--handle`) · `--no-replies` · `--reply-lang LANG` · `--rules "TEXT"` · `--ask "QUESTION"` (answer directly; server reads images first) · `--raw` (cited list only, no report) · `--session ID` · `--json` · `--quiet` · `--timeout SEC`

## Rules

- **Understanding happens on the server. Never fetch media yourself.** For "what does this post mean", run `ask <url> <question>` and relay the answer. The client usually cannot reach X at all.
- **Ask in plain language.** The server plans the X queries. Text that already contains operators (`from:`, `min_faves:`, `"exact"`, `OR`) is passed through untouched.
- **Dates, handles and language go in flags**, not in the request text; the server compiles them into operators.
- **Follow up with `--session`** instead of searching again. Sessions live about two hours.
- **Empty results are real.** `posts: []` with no warnings means X has nothing for that query.
- **Relay permalinks and quoted text verbatim**, keep engagement numbers with their post, and say the results came from an X search.

## Limits

Shared server quota (default 40 per 15 min, 600 per day; a search uses up to 3). The endpoint sits behind Cloudflare, which waits about 100 s; a search takes 5–50 s. Only what a logged-in user sees. `UPSTREAM_CHANGED` means the server's parser needs updating, not that the query was wrong. The token grants use of the owner's account: keep the config file 0600 and never paste it anywhere.
