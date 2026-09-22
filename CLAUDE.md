# CLAUDE.md — dsh-x-search

dsh / cordis plugin: natural-language X search with the user's own X account. The client skill lives in `skills/dsh-x`.

## Commands

```bash
npm run check        # tsc --noEmit
npx vitest run       # all tests; no network, no browser; static guards in test/plugin.test.ts
npm pack             # deploy tarball (the skill is not in it; it ships with the repo)
```

## Layers

| Layer | File | Rule |
|---|---|---|
| Query | `src/query.ts` | Constraints (dates, handle lists, language) are compiled by code, never by the model. Limits mirror xAI `x_search` (≤ 20 handles, allowed/excluded exclusive). |
| Parse | `src/parse.ts` | Lenient, counts what it skips, never throws. `entriesSeen === 0` is the only "shape changed" signal. |
| Browser | `src/browser.ts` | Persistent Chromium + imported cookies; reads the page's own GraphQL responses, never the DOM. Cookie values never reach logs, status or errors. |
| Limiter | `src/limiter.ts` | Account safety valve. Do not raise the defaults. |
| Model | `src/llm.ts` | Plan / report / follow-up / answer via `ctx.get('llm')`. Degrades, never throws. |
| Vision | `src/vision.ts` | Fetches post images, calls an OpenAI-compatible `chat/completions` with `image_url`. Key from `DEEPSEEK_API_KEY` (env or `$DSH_HOME/.env`). Failures only warn. |
| Service | `src/service.ts` | Orchestration and session cache. Validate before running any query; on quota exhaustion return what was fetched plus a warning. |
| Web / tools | `src/web.ts`, `src/tools.ts` | HTTP (loopback only, Bearer) and harness tools. Errors are `{ok:false, code, message}`. |
| Skill | `skills/dsh-x` | Stdlib Python client. Understanding happens on the server; the client never fetches media. Keep `references/api.md` in sync with `web.ts`. |

## Rules

1. Read the page's API responses, not the DOM.
2. Login state comes only from the user's browser. The server never logs in.
3. Empty (`posts: []`, `entriesSeen > 0`) and broken (`entriesSeen === 0` → `UPSTREAM_CHANGED`) are different results.
4. Session loss fails closed until cookies are re-imported.
5. The model is optional. Every path returns posts without it.
6. Understanding is done server-side: `question` → read media → answer. The client only relays.
7. Every fire-and-forget promise gets a `.catch`. dsh ≥ 0.1.5-rc.2 kills the process on an unhandled rejection within 2 s.
8. Fix the parser fixture-first: `scripts/capture.ts` → `test/fixtures/timeline.ts` → `src/parse.ts`.
9. Public repo: no hostnames, IPs, domains, real paths, time zones or account names. Host-specific values live in the profile overlay and systemd drop-ins; docs use `<host>`, `<zone>` and the example user `dsh`.
10. Docs are English and short. `README.zh-CN.md` mirrors `README.md`; nothing else is translated.

## Deployment shape

Profile `x-search` + unit `x-search.service`, HTTP on `127.0.0.1:31890`, data dir outside `.dsh`, public access through `x-search-tunnel.service` (Cloudflare Tunnel) with the plugin's Bearer token. Steps in `deploy/README.md`.
