#!/usr/bin/env bash
# Install Playwright's Chromium and its system libraries on the server. Run as the unit's user; the system-library step uses sudo.
#
#   bash deploy/install-browser.sh $DSH_HOME/profiles/x-search
#
# The argument is the profile directory (its node_modules/playwright is the copy that gets used). The browser goes to
# $PLAYWRIGHT_BROWSERS_PATH (default ~/.cache/ms-playwright); the unit file must point at the same place.
set -Eeuo pipefail

PROFILE_DIR="${1:?usage: install-browser.sh <profile dir>}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

cd "$PROFILE_DIR"
test -d node_modules/playwright || { echo "no node_modules/playwright in the profile; run pnpm install first"; exit 1; }

echo "1/3 system libraries (sudo; only what Chromium needs)"
sudo -n "$NODE_BIN" node_modules/playwright/cli.js install-deps chromium

echo "2/3 Chromium into $PLAYWRIGHT_BROWSERS_PATH"
"$NODE_BIN" node_modules/playwright/cli.js install chromium

echo "3/3 self-test: launch headless and open about:blank"
"$NODE_BIN" --input-type=module -e "
import { chromium } from 'playwright'
const b = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const p = await b.newPage(); await p.goto('about:blank'); console.log('chromium', b.version(), 'ok'); await b.close()
"
du -sh "$PLAYWRIGHT_BROWSERS_PATH" | sed 's/^/browser size /'
