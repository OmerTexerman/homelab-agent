#!/usr/bin/env bash
# Host-side health checks for the Homelab Agent LXC. Installed as
# /usr/local/sbin/homelab-agent-health and run every 15 minutes by
# homelab-agent-health.timer on the Proxmox host, so it alerts even when the
# app or the container is down.
#
# Each check raises an ntfy alert through homelab-agent-notify (deduplicated by
# key) or resolves it when the condition clears:
#
#   container      LXC not running
#   disk           container root filesystem >= warn / urgent percent
#   app            t3code.service inactive or /api/auth/session failing inside the LXC
#   restarts       t3code.service NRestarts went up since the last check
#   public         the public URL failing from the host
#   backup-mount   NAS backup mount missing or not writable
#   backup-age     newest backup older than N days (backups happen on deploys)
#   tls            public certificate expiring soon or unreadable
#   autodeploy     autodeploy timer inactive, or N runs in a row failed unexplained
#   docker         image + build-cache size or dangling images above threshold (low)
#
# Thresholds come from HEALTH_* lines in /etc/homelab-agent/notify.env (see
# notify.env.example); the environment overrides them. Always exits 0.
set -uo pipefail

ctid="${HOMELAB_AGENT_CTID:-201}"
config_file="${HOMELAB_AGENT_NOTIFY_ENV:-/etc/homelab-agent/notify.env}"
notify_bin="${HOMELAB_AGENT_NOTIFY:-/usr/local/sbin/homelab-agent-notify}"
health_state_dir="${HOMELAB_AGENT_HEALTH_STATE_DIR:-/var/lib/homelab-agent/health}"
backup_dir="${HOMELAB_AGENT_BACKUP_DIR:-/mnt/pve/nas-backups/homelab-agent}"
backup_mount="${HOMELAB_AGENT_BACKUP_MOUNT-/mnt/pve/nas-backups}"
deploy_lock="${HOMELAB_AGENT_DEPLOY_LOCK:-/run/homelab-agent-ai-agent-deploy.lock}"
failures_file="${HOMELAB_AGENT_DEPLOY_FAILURES_FILE:-/var/lib/homelab-agent/deploy-failures}"
autodeploy_unit="homelab-agent-ai-agent-autodeploy"
local_health_url="http://127.0.0.1:3000/api/auth/session"

log() {
  printf '[homelab-agent-health] %s\n' "$*" >&2
}

# HEALTH_* lines from the config file, unless already set in the environment.
if [[ -r "$config_file" ]]; then
  while IFS='=' read -r name value; do
    value="${value%$'\r'}"
    value="${value#\"}" value="${value%\"}"
    if [[ -z "${!name+x}" ]]; then
      printf -v "$name" '%s' "$value"
    fi
  done < <(grep -E '^HEALTH_[A-Z_]+=' "$config_file")
fi
disk_warn="${HEALTH_DISK_WARN_PERCENT:-85}"
disk_urgent="${HEALTH_DISK_URGENT_PERCENT:-95}"
backup_max_age_days="${HEALTH_BACKUP_MAX_AGE_DAYS:-8}"
tls_host="${HEALTH_TLS_HOST-ai.texerman.com}"
tls_port="${HEALTH_TLS_PORT:-443}"
tls_min_days="${HEALTH_TLS_MIN_DAYS:-14}"
public_url="${HEALTH_PUBLIC_URL-https://ai.texerman.com/api/auth/session}"
deploy_failures_max="${HEALTH_DEPLOY_FAILURES:-3}"
docker_max_gb="${HEALTH_DOCKER_MAX_GB:-20}"
docker_max_dangling="${HEALTH_DOCKER_MAX_DANGLING:-10}"

raised=0
notify() {
  if [[ -x "$notify_bin" ]]; then
    "$notify_bin" "$@" || true
  else
    log "notify skipped ($notify_bin not installed): $*"
  fi
}

# raise <check> <priority> <title> <message> [repeat-hours]
raise() {
  raised=$((raised + 1))
  log "ALERT $1 ($2): $4"
  notify --key "health-$1" --priority "$2" --tags "warning" ${5:+--every "$5"} --title "$3" "$4"
}

# ok <check> [message]: resolves the check if it was raised.
ok() {
  notify --resolve "health-$1" ${2:+"$2"}
}

ct() {
  timeout 60 pct exec "$ctid" -- "$@"
}

check_container() {
  if pct status "$ctid" 2>/dev/null | grep -q 'status: running'; then
    ok container "LXC ${ctid} is running again."
    return 0
  fi
  raise container urgent "Homelab Agent LXC ${ctid} is not running" \
    "pct status ${ctid}: $(pct status "$ctid" 2>&1 | head -n 1). Start it with: pct start ${ctid}"
  return 1
}

check_disk() {
  local used
  used="$(ct df -P / 2>/dev/null | awk 'NR == 2 { sub("%", "", $5); print $5 }')"
  if [[ ! "$used" =~ ^[0-9]+$ ]]; then
    raise disk default "Homelab Agent disk check failed" "Could not read df / inside LXC ${ctid}."
    return
  fi
  local hint="Look with: pct exec ${ctid} -- du -xhd1 / | sort -h, and pct exec ${ctid} -- docker system df."
  if ((used >= disk_urgent)); then
    raise disk urgent "Homelab Agent LXC disk ${used}% full" "LXC ${ctid} root is ${used}% used (urgent at ${disk_urgent}%). ${hint}"
  elif ((used >= disk_warn)); then
    raise disk high "Homelab Agent LXC disk ${used}% full" "LXC ${ctid} root is ${used}% used (warn at ${disk_warn}%). ${hint}"
  else
    ok disk "LXC ${ctid} root is back to ${used}% used."
  fi
}

check_app() {
  # A deploy restarts the service; don't report its restart window.
  if ! flock -n "$deploy_lock" true 2>/dev/null; then
    log "deploy in progress; skipping service checks"
    return
  fi
  local state restarts previous_restarts restarts_file="$health_state_dir/nrestarts"
  state="$(ct systemctl is-active t3code.service 2>/dev/null)"
  if [[ "$state" != "active" ]]; then
    raise app urgent "Homelab Agent is down (t3code.service ${state:-unknown})" \
      "t3code.service is ${state:-unknown} in LXC ${ctid}. Logs: pct exec ${ctid} -- journalctl -u t3code.service -n 100"
  elif ! ct curl -fsS -o /dev/null --max-time 10 --retry 2 --retry-delay 5 --retry-connrefused "$local_health_url" 2>/dev/null; then
    raise app urgent "Homelab Agent is not answering" \
      "t3code.service is active but ${local_health_url} fails inside LXC ${ctid}. Logs: pct exec ${ctid} -- journalctl -u t3code.service -n 100"
  else
    ok app "t3code.service is active and answering."
  fi

  restarts="$(ct systemctl show t3code.service -p NRestarts --value 2>/dev/null)"
  if [[ "$restarts" =~ ^[0-9]+$ ]]; then
    previous_restarts="$(cat "$restarts_file" 2>/dev/null)"
    mkdir -p "$health_state_dir" && printf '%s\n' "$restarts" >"$restarts_file"
    if [[ "$previous_restarts" =~ ^[0-9]+$ ]] && ((restarts > previous_restarts)); then
      raise restarts high "Homelab Agent is restarting" \
        "t3code.service restarted $((restarts - previous_restarts)) time(s) since the last check (NRestarts ${restarts}). Logs: pct exec ${ctid} -- journalctl -u t3code.service -n 200"
    else
      ok restarts "t3code.service stopped restarting."
    fi
  fi
}

check_public() {
  [[ -n "$public_url" ]] || return
  if curl -fsS -o /dev/null --max-time 15 --retry 2 --retry-delay 5 "$public_url" 2>/dev/null; then
    ok public "${public_url} answers again."
  else
    raise public high "Homelab Agent public URL failing" \
      "${public_url} fails from the Proxmox host (reverse proxy, DNS, or the app)."
  fi
}

check_backups() {
  if [[ -n "$backup_mount" ]] && ! mountpoint -q "$backup_mount"; then
    raise backup-mount high "Homelab Agent backup mount missing" \
      "${backup_mount} is not mounted on the Proxmox host; deploys will refuse to run until it is."
    return
  fi
  local probe="$backup_dir/.health-write-test"
  if ! { mkdir -p "$backup_dir" && : >"$probe" && rm -f "$probe"; } 2>/dev/null; then
    raise backup-mount high "Homelab Agent backup dir not writable" "Cannot write to ${backup_dir} on the Proxmox host."
    return
  fi
  ok backup-mount "${backup_dir} is mounted and writable again."

  local newest now age_days
  newest="$(find "$backup_dir" -maxdepth 1 -name 't3code-home-*.tar.gz' -printf '%T@\n' 2>/dev/null | sort -rn | head -n 1)"
  newest="${newest%.*}"
  now="$(date +%s)"
  if [[ -z "$newest" ]]; then
    raise backup-age default "Homelab Agent has no backups" "No t3code-home-*.tar.gz in ${backup_dir}."
    return
  fi
  age_days=$(((now - newest) / 86400))
  if ((age_days >= backup_max_age_days)); then
    raise backup-age default "Homelab Agent backup is ${age_days} days old" \
      "The newest backup in ${backup_dir} is ${age_days} days old (limit ${backup_max_age_days}). Backups are taken on each deploy."
  else
    ok backup-age "A fresh backup exists in ${backup_dir}."
  fi
}

# Reads the certificate actually served (not the file on disk), so a renewed
# certificate the proxy never reloaded still counts as expiring.
check_tls() {
  [[ -n "$tls_host" ]] || return
  local end_date end_epoch days_left
  end_date="$(timeout 20 openssl s_client -connect "${tls_host}:${tls_port}" -servername "$tls_host" </dev/null 2>/dev/null |
    openssl x509 -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p')"
  if [[ -z "$end_date" ]] || ! end_epoch="$(date -d "$end_date" +%s 2>/dev/null)"; then
    raise tls default "Homelab Agent TLS check failed" "Could not read the certificate served by ${tls_host}:${tls_port}."
    return
  fi
  days_left=$(((end_epoch - $(date +%s)) / 86400))
  if ((days_left < 3)); then
    raise tls urgent "Homelab Agent TLS cert expires in ${days_left} days" \
      "${tls_host} serves a certificate expiring ${end_date}. Renew it and reload the reverse proxy."
  elif ((days_left < tls_min_days)); then
    raise tls high "Homelab Agent TLS cert expires in ${days_left} days" \
      "${tls_host} serves a certificate expiring ${end_date}. If it was renewed, the reverse proxy was not reloaded."
  else
    ok tls "${tls_host} serves a certificate valid for ${days_left} more days."
  fi
}

check_autodeploy() {
  if ! systemctl is-active --quiet "${autodeploy_unit}.timer"; then
    raise autodeploy high "Homelab Agent autodeploy timer is not active" \
      "${autodeploy_unit}.timer is $(systemctl is-active "${autodeploy_unit}.timer" 2>/dev/null). Start it with: systemctl enable --now ${autodeploy_unit}.timer"
    return
  fi
  local failures
  failures="$(cat "$failures_file" 2>/dev/null)"
  [[ "$failures" =~ ^[0-9]+$ ]] || failures=0
  if ((failures >= deploy_failures_max)); then
    local recent
    recent="$(journalctl -u "${autodeploy_unit}.service" -n 5 --no-pager -o cat 2>/dev/null | tail -n 5)"
    raise autodeploy high "Homelab Agent autodeploy failing" \
      "The last ${failures} autodeploy runs failed. Logs: journalctl -u ${autodeploy_unit}.service -n 200${recent:+
${recent}}"
  else
    ok autodeploy "Autodeploy runs succeed again."
  fi
}

# Docker's human sizes (0B, 12.5kB, 3.1MB, 1.2GB) to gigabytes.
to_gb() {
  awk '{
    n = $0; sub(/[A-Za-z]+$/, "", n); u = $0; sub(/^[0-9.]+/, "", u)
    m = (u == "TB") ? 1000 : (u == "GB") ? 1 : (u == "MB") ? 0.001 : (u == "kB" || u == "KB") ? 0.000001 : 0
    printf "%.1f", n * m
  }' <<<"$1"
}

check_docker() {
  local df images_gb=0 cache_gb=0 dangling stopped total
  if ! df="$(ct docker system df --format '{{.Type}}|{{.Size}}' 2>/dev/null)"; then
    log "docker system df failed inside LXC ${ctid}; skipping docker check"
    return
  fi
  while IFS='|' read -r type size; do
    case "$type" in
      Images) images_gb="$(to_gb "$size")" ;;
      "Build Cache") cache_gb="$(to_gb "$size")" ;;
    esac
  done <<<"$df"
  dangling="$(ct docker images -q -f dangling=true 2>/dev/null | wc -l)"
  stopped="$(ct docker ps -aq -f label=homelab.runtime.id -f status=exited 2>/dev/null | wc -l)"
  total="$(awk -v a="$images_gb" -v b="$cache_gb" 'BEGIN { printf "%.1f", a + b }')"
  if awk -v t="$total" -v max="$docker_max_gb" 'BEGIN { exit !(t >= max) }' || ((dangling >= docker_max_dangling)); then
    raise docker low "Homelab Agent Docker storage growing" \
      "LXC ${ctid}: images ${images_gb} GB, build cache ${cache_gb} GB (limit ${docker_max_gb} GB together), ${dangling} dangling image(s), ${stopped} stopped runtime container(s). Reclaim with: pct exec ${ctid} -- docker builder prune -f && pct exec ${ctid} -- docker image prune -f" 24
  else
    ok docker "Docker storage in LXC ${ctid} is back under ${docker_max_gb} GB."
  fi
}

if check_container; then
  check_disk
  check_app
  check_docker
fi
check_public
check_backups
check_tls
check_autodeploy
log "done: ${raised} alert(s) raised"
exit 0
