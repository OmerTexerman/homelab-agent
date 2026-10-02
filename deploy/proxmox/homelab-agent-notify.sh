#!/usr/bin/env bash
# Sends a Homelab Agent alert to ntfy from the Proxmox host. Installed as
# /usr/local/sbin/homelab-agent-notify and used by the deploy, health, and
# restore-drill scripts. Runs on the host, so alerts still go out when the app
# (or the whole LXC) is down.
#
#   homelab-agent-notify --title T [--priority P] [--tags a,b] [--click URL]
#                        [--key KEY [--id ID] [--every HOURS]] MESSAGE
#   homelab-agent-notify --resolve KEY [MESSAGE]
#
# Priority is min, low, default, high, or urgent.
#
# With --key, an alert is a condition that stays raised until resolved: the
# same key is sent at most once every HOURS (default NOTIFY_REPEAT_HOURS, 12;
# 0 means only once), but immediately again when the priority goes up or the
# --id changes (for example a new commit failing the same way). --resolve KEY
# sends a "Resolved" message only if KEY was raised, then clears it; it is a
# cheap no-op otherwise, so callers can resolve on every healthy check.
#
# Config: /etc/homelab-agent/notify.env with NTFY_URL (full topic URL) and
# optional NTFY_TOKEN (Bearer). Without it alerts are disabled (one log line).
# Never fails the caller: every outcome exits 0 except bad usage (exit 2).
set -uo pipefail

config_file="${HOMELAB_AGENT_NOTIFY_ENV:-/etc/homelab-agent/notify.env}"
state_dir="${HOMELAB_AGENT_NOTIFY_STATE_DIR:-/var/lib/homelab-agent/notify}"

log() {
  printf '[homelab-agent-notify] %s\n' "$*" >&2
}

usage() {
  sed -n '7,12p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

priority_rank() {
  case "$1" in
    min | 1) printf 1 ;;
    low | 2) printf 2 ;;
    default | 3) printf 3 ;;
    high | 4) printf 4 ;;
    urgent | max | 5) printf 5 ;;
    *) return 1 ;;
  esac
}

title="" priority="default" tags="" click="" key="" id="" every="" resolve="" message=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) title="${2-}"; shift 2 || usage ;;
    --priority) priority="${2-}"; shift 2 || usage ;;
    --tags) tags="${2-}"; shift 2 || usage ;;
    --click) click="${2-}"; shift 2 || usage ;;
    --key) key="${2-}"; shift 2 || usage ;;
    --id) id="${2-}"; shift 2 || usage ;;
    --every) every="${2-}"; shift 2 || usage ;;
    --resolve) resolve=1; key="${2-}"; shift 2 || usage ;;
    -h | --help) usage ;;
    --) shift; message="$*"; break ;;
    -*) log "unknown option: $1"; usage ;;
    *) message="$*"; break ;;
  esac
done
priority_rank "$priority" >/dev/null || { log "bad priority: $priority"; usage; }
[[ -n "$resolve" && -z "$key" ]] && usage
[[ -z "$resolve" && -z "$title$message" ]] && usage

# KEY=VALUE lines only; the file is parsed, never sourced.
NTFY_URL="" NTFY_TOKEN="" NOTIFY_REPEAT_HOURS=""
if [[ -r "$config_file" ]]; then
  while IFS='=' read -r name value; do
    value="${value%$'\r'}"
    value="${value#\"}" value="${value%\"}"
    value="${value#\'}" value="${value%\'}"
    case "$name" in
      NTFY_URL) NTFY_URL="$value" ;;
      NTFY_TOKEN) NTFY_TOKEN="$value" ;;
      NOTIFY_REPEAT_HOURS) NOTIFY_REPEAT_HOURS="$value" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "$config_file")
fi
if [[ -z "$NTFY_URL" ]]; then
  log "alerts disabled (no NTFY_URL in $config_file); would have sent: ${title:-resolve $key}"
  exit 0
fi
every="${every:-${NOTIFY_REPEAT_HOURS:-12}}"
[[ "$every" =~ ^[0-9]+$ ]] || every=12

state_file=""
if [[ -n "$key" ]]; then
  state_file="$state_dir/$(printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_').state"
fi

state_ts="" state_priority="" state_id="" state_title=""
if [[ -n "$state_file" && -f "$state_file" ]]; then
  while IFS='=' read -r name value; do
    case "$name" in
      ts) state_ts="$value" ;;
      priority) state_priority="$value" ;;
      id) state_id="$value" ;;
      title) state_title="$value" ;;
    esac
  done <"$state_file"
fi

send() {
  local send_title="$1" send_priority="$2" send_tags="$3" body="$4"
  local args=(-sS -o /dev/null --fail --max-time 15 --retry 2 --retry-delay 2
    -H "Title: $send_title" -H "Priority: $send_priority")
  [[ -n "$send_tags" ]] && args+=(-H "Tags: $send_tags")
  [[ -n "$click" ]] && args+=(-H "Click: $click")
  [[ -n "$NTFY_TOKEN" ]] && args+=(-H "Authorization: Bearer $NTFY_TOKEN")
  if printf '%s' "$body" | curl "${args[@]}" --data-binary @- "$NTFY_URL"; then
    return 0
  fi
  log "failed to send \"$send_title\" to ntfy"
  return 1
}

if [[ -n "$resolve" ]]; then
  [[ -n "$state_ts" ]] || exit 0
  if send "Resolved: ${state_title:-$key}" low "white_check_mark" "${message:-Cleared: ${state_title:-$key}}"; then
    rm -f "$state_file"
  fi
  exit 0
fi

if [[ -n "$state_ts" ]]; then
  now="$(date +%s)"
  new_rank="$(priority_rank "$priority")"
  old_rank="$(priority_rank "${state_priority:-default}" 2>/dev/null || printf 3)"
  repeat_due=0
  if ((every > 0 && now - state_ts >= every * 3600)); then
    repeat_due=1
  fi
  if [[ "$state_id" == "$id" ]] && ((new_rank <= old_rank)) && ((repeat_due == 0)); then
    log "suppressed repeat of $key (last sent $(((now - state_ts) / 60)) min ago)"
    exit 0
  fi
fi

if send "${title:-Homelab Agent}" "$priority" "$tags" "${message:-$title}" && [[ -n "$state_file" ]]; then
  mkdir -p "$state_dir" 2>/dev/null
  tmp="$state_file.tmp.$$"
  # Title and id are kept on one line each; strip newlines.
  if printf 'ts=%s\npriority=%s\nid=%s\ntitle=%s\n' "$(date +%s)" "$priority" "${id//$'\n'/ }" "${title//$'\n'/ }" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$state_file"
  else
    rm -f "$tmp"
    log "could not record alert state in $state_dir"
  fi
fi
exit 0
