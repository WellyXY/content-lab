#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SITE_SYNC_URL="https://content-lab-welly.biii38839.chatgpt.site"
export CONTENT_LAB_WORKER_ID="mac-welly-content-lab"
export SITE_SYNC_TOKEN="$(/usr/bin/security find-generic-password -w -a welly -s com.welly.content-lab.site-sync)"

cd "/Users/welly/Documents/Codex/Projects/Pop Up agent/content-lab/service"
exec /opt/homebrew/bin/npm run worker
