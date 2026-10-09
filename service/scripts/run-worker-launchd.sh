#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SITE_SYNC_URL="https://content-lab-welly.biii38839.chatgpt.site"
export SITE_PLAYBOOK_SYNC="1"
export PUBLIC_BASE_URL="https://content-lab-welly.biii38839.chatgpt.site"
export CONTENT_LAB_WORKER_ID="mac-welly-content-lab"

keychain_value() {
  local service="$1"
  local account="${2:-}"
  if [[ -n "$account" ]]; then
    /usr/bin/security find-generic-password -w -a "$account" -s "$service" 2>/dev/null || true
  else
    /usr/bin/security find-generic-password -w -s "$service" 2>/dev/null || true
  fi
}

if [[ -z "${SITE_SYNC_TOKEN:-}" ]]; then
  export SITE_SYNC_TOKEN="$(/usr/bin/security find-generic-password -w -a welly -s com.welly.content-lab.site-sync)"
fi
export FEISHU_APP_ID="${FEISHU_APP_ID:-$(keychain_value com.welly.content-lab.feishu-app-id welly)}"
owner_open_id=""
if [[ -n "$FEISHU_APP_ID" ]]; then
  if [[ -z "${FEISHU_APP_SECRET:-}" ]]; then
    export FEISHU_APP_SECRET="$(/usr/bin/security find-generic-password -w -a "$FEISHU_APP_ID" -s com.welly.content-lab.feishu-app-secret)"
  fi
  owner_open_id="$(keychain_value com.welly.content-lab.feishu-owner-open-id "$FEISHU_APP_ID")"
  export FEISHU_ALLOWED_SENDER_IDS="${FEISHU_ALLOWED_SENDER_IDS:-$owner_open_id}"
fi
export FEISHU_ALERT_CHAT_ID="${FEISHU_ALERT_CHAT_ID:-$(keychain_value com.welly.content-lab.feishu-alert-chat-id welly)}"
if [[ -z "${FEISHU_ALERT_OPEN_ID+x}" && -z "$FEISHU_ALERT_CHAT_ID" ]]; then
  export FEISHU_ALERT_OPEN_ID="$owner_open_id"
fi
export FEISHU_ALLOWED_CHAT_IDS="${FEISHU_ALLOWED_CHAT_IDS:-$(keychain_value com.welly.content-lab.feishu-allowed-chat-ids welly)}"
export FEISHU_WEBHOOK_URL="${FEISHU_WEBHOOK_URL:-$(keychain_value com.welly.content-lab.feishu-webhook-url welly)}"

cd "/Users/welly/Documents/Codex/Projects/Pop Up agent/content-lab/service"
exec /opt/homebrew/bin/node --import tsx src/worker.ts
