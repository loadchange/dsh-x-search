# Deploy

One dsh profile `x-search` + one systemd unit. HTTP on `127.0.0.1:31890` only; public access through a Cloudflare Tunnel with a Bearer token.

Placeholders: `<host>` ssh alias · `<zone>` your Cloudflare domain · `dsh` / `/home/dsh` example service user · `$DSH_HOME` dsh runtime dir (contains `profiles/`) · `$DATA` plugin data dir (cookies, browser profile, rate counters), **outside `.dsh`** — the host watches that tree and reloads on writes.

## Prerequisites

- dsh ≥ 0.1.5-rc.2, Node ≥ 22, and a model route for the profile (`agentDefaultModel`). Without a model: raw citations only, no `question`.
- `DEEPSEEK_API_KEY` (env or `$DSH_HOME/.env`) for image reading; `DEEPSEEK_BASE_URL` optional.

## 1. Cookies

Copy `auth_token` and `ct0` from your logged-in browser (DevTools → Application → Cookies → `https://x.com`) into `cookies.json`, then move it file-to-file:

```json
{ "auth_token": "…", "ct0": "…" }
```

```bash
ssh <host> "install -d -m 0700 $DATA" && scp cookies.json <host>:$DATA/cookies.json && ssh <host> "chmod 0600 $DATA/cookies.json" && rm cookies.json
```

Do not log out in that browser; it invalidates the server copy. Prefer a dedicated account. After `SESSION_EXPIRED`: re-import, then `systemctl restart x-search`.

## 2. Profile

```bash
P=$DSH_HOME/profiles/x-search; mkdir -p $P $DATA/vendor
# on the dev machine: npm pack, then scp the tarball to $DATA/vendor/
cat > $P/package.json <<EOF2
{ "name": "dsh-profile-x-search", "private": true,
  "dependencies": { "dsh-x-search": "file:$DATA/vendor/dsh-x-search-<version>.tgz" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-x-search"] } } }
EOF2
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > $P/pnpm-workspace.yaml   # peers come from the host
cat > $P/cordis.patch.yml <<EOF2
- id: x-search
  config:
    dataDir: $DATA
    cookiesFile: $DATA/cookies.json
    browser:
      timezoneId: ''    # empty = system zone; use the zone of your egress IP and never change it
EOF2
cd $P && pnpm install --no-frozen-lockfile
```

The model route goes in the same overlay, like any other profile. Secrets (`DEEPSEEK_API_KEY`, `X_SEARCH_TOKEN`) go in `$DATA/env` (0600), loaded by the unit's `EnvironmentFile=`. Host-specific base URLs go in a drop-in `x-search.service.d/host.conf`.

## 3. Chromium

```bash
bash deploy/install-browser.sh $DSH_HOME/profiles/x-search    # sudo for system libs; ~150 MB into ~/.cache/ms-playwright
```

## 4. Check the parser against live responses

```bash
cd $P/node_modules/dsh-x-search
node --experimental-strip-types scripts/capture.ts --cookies $DATA/cookies.json --data-dir $DATA --out /tmp/x-capture search "zed editor"
node --experimental-strip-types scripts/capture.ts ... user karpathy
node --experimental-strip-types scripts/capture.ts ... thread https://x.com/karpathy/status/2081195664479068350
```

All three must report posts > 0, profile parsed, focal post found. Otherwise fix fixture-first: `test/fixtures/timeline.ts`, then `src/parse.ts`.

## 5. Unit

Edit `User=`, `Group=` and `/home/dsh` in `deploy/x-search.service`, then:

```bash
sudo install -m 0644 deploy/x-search.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now x-search.service
curl -s 127.0.0.1:31890/healthz      # {"ok":true,"session":"unknown"} until the first real request
```

## 6. Public access: Cloudflare Tunnel + Bearer token

1. `X_SEARCH_TOKEN=$(openssl rand -hex 32)` in `$DATA/env`. With it set, `/api/*` requires `Authorization: Bearer …`; `/healthz` stays open for probes. Rotate by editing the line and restarting.
2. Create a named tunnel (dashboard or `cf` CLI): ingress `x-search.<zone>` → `http://127.0.0.1:31890`, proxied CNAME `x-search` → `<uuid>.cfargotunnel.com`. Put the tunnel token in `/etc/x-search-tunnel/token` (root, 0400, no surrounding quotes) and install `deploy/x-search-tunnel.service`.
3. No Cloudflare Access: callers are agents. Cloudflare waits about 100 s for the origin; keep `llm.timeoutMs` and query counts under that.

## 7. Client

```bash
npx skills@latest add loadchange/dsh-x-search
python3 <skill-dir>/scripts/dsh_x.py config --url https://x-search.<zone> --token <token>
python3 <skill-dir>/scripts/dsh_x.py check
```

Raw HTTP works too: `curl -H "authorization: Bearer $TOKEN" -H content-type:application/json -d '{"request":"…"}' https://x-search.<zone>/api/search`. Send a real User-Agent or Cloudflare rejects the request.

## Rollback

`sudo systemctl disable --now x-search.service x-search-tunnel.service`. Logging out of X in your browser invalidates the server cookies.
