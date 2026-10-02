#!/usr/bin/env bash
# Proxmox-host auto-deploy for the Homelab Agent LXC. Installed as
# /usr/local/sbin/homelab-agent-deploy-ai-agent.sh and run by
# homelab-agent-ai-agent-autodeploy.timer every ~5 minutes.
#
# Flow: prepare (build + real-data smoke in a separate release dir, inside the
# container) -> back up -> drain running turns -> activate -> restart -> health
# check -> roll back on failure when the release added no migration.
#
# `prod` only advances to commits whose CI passed (.github/workflows/promote-prod.yml).
# Touch $pause_file to pause deploys.
#
# Failures and new deploys are reported through homelab-agent-notify (ntfy).
# Runs that fail without a specific alert are counted in $failures_file, which
# homelab-agent-health alerts on.
set -Eeuo pipefail

ctid="${HOMELAB_AGENT_CTID:-201}"
service_home="${HOMELAB_AGENT_SERVICE_HOME:-/home/t3code}"
source_dir="${HOMELAB_AGENT_SOURCE_DIR:-/opt/homelab-agent}"
branch="${HOMELAB_AGENT_BRANCH:-prod}"
state_dir="$service_home/.t3"
releases_dir="$service_home/homelab-agent-releases"
backup_dir="${HOMELAB_AGENT_BACKUP_DIR:-/mnt/pve/nas-backups/homelab-agent}"
# Backups must land on this mount, never on the host's own disk. Empty disables the check.
backup_mount="${HOMELAB_AGENT_BACKUP_MOUNT-/mnt/pve/nas-backups}"
backups_to_keep="2"
releases_to_keep="1"
drain_max_seconds="${HOMELAB_AGENT_DRAIN_MAX_SECONDS:-1200}"
health_url="http://127.0.0.1:3000/api/auth/session"
lock_path="${HOMELAB_AGENT_DEPLOY_LOCK:-/run/homelab-agent-ai-agent-deploy.lock}"
pause_file="${HOMELAB_AGENT_PAUSE_FILE:-/etc/homelab-agent/deploy.paused}"
notify_bin="${HOMELAB_AGENT_NOTIFY:-/usr/local/sbin/homelab-agent-notify}"
failures_file="${HOMELAB_AGENT_DEPLOY_FAILURES_FILE:-/var/lib/homelab-agent/deploy-failures}"
logs_hint="journalctl -u homelab-agent-ai-agent-autodeploy.service -n 200"

log() {
  printf '[homelab-agent-deploy] %s\n' "$*"
}

# Set once a run has sent the alert that explains its failure.
alerted=0

# alert <priority> <title> <message>: the "deploy" condition, raised once per
# target commit (and on escalation) and resolved by the next good deploy.
alert() {
  local priority="$1" title="$2" message="$3"
  alerted=1
  notify --key deploy --id "${target:-unknown}" --every 0 --priority "$priority" \
    --tags "rotating_light" --title "$title" "$message"
}

notify() {
  if [[ -x "$notify_bin" ]]; then
    "$notify_bin" "$@" || true
  else
    log "notify skipped ($notify_bin not installed): $*"
  fi
}

# Counts consecutive runs that failed without their own alert; any success
# (including a NOOP run) resets it. Installed as the EXIT trap below.
# shellcheck disable=SC2329
record_run() {
  local rc=$? count=0
  mkdir -p "$(dirname "$failures_file")" 2>/dev/null || return 0
  if [[ "$rc" -eq 0 ]]; then
    count=0
  elif [[ "$alerted" -eq 1 ]]; then
    return 0
  else
    count="$(cat "$failures_file" 2>/dev/null || printf 0)"
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
    count=$((count + 1))
  fi
  printf '%s\n' "$count" >"$failures_file" 2>/dev/null || true
}

ct_t3() {
  pct exec "$ctid" -- runuser -u t3code -- env \
    HOME="$service_home" \
    PATH="$service_home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" \
    T3CODE_HOME="$state_dir" \
    HOMELAB_AGENT_SOURCE_DIR="$source_dir" \
    HOMELAB_AGENT_RELEASES_DIR="$releases_dir" \
    HOMELAB_AGENT_BRANCH="$branch" \
    "$@"
}

ct_root() {
  pct exec "$ctid" -- "$@"
}

# release.sh always runs from the commit being deployed (already CI-green), so
# deploy logic ships with the code it deploys.
release() {
  ct_t3 bash -c 'script="$(mktemp -d)"; trap "rm -rf \"$script\"" EXIT
    git -C "$HOMELAB_AGENT_SOURCE_DIR" show "origin/$HOMELAB_AGENT_BRANCH:scripts/deploy/release.sh" >"$script/release.sh"
    git -C "$HOMELAB_AGENT_SOURCE_DIR" show "origin/$HOMELAB_AGENT_BRANCH:scripts/deploy/state-db.mjs" >"$script/state-db.mjs"
    bash "$script/release.sh" "$@"' release "$@"
}

prune_backups() {
  local stale
  stale="$(ls -1t "${backup_dir}"/t3code-home-*.tar.gz 2>/dev/null | tail -n +$((backups_to_keep + 1)))"
  if [[ -n "$stale" ]]; then
    log "pruning $(printf '%s\n' "$stale" | wc -l) old backup(s); keeping newest ${backups_to_keep}"
    printf '%s\n' "$stale" | xargs -r rm -f --
  fi
}

# Backs up everything except the live database files (state.sqlite and
# homelab.sqlite, each replaced by a consistent VACUUM INTO snapshot) and
# reinstallable caches. Returns 1 (with the reason in $backup_error) on failure;
# it runs as an `if` condition, so every step checks its own status.
backup_error=""
backup_state() {
  local timestamp backup_path snapshot="$state_dir/userdata/state.backup.sqlite"
  local homelab_snapshot="$state_dir/userdata/homelab.backup.sqlite"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="${backup_dir}/t3code-home-${timestamp}.tar.gz"
  if [[ -n "$backup_mount" ]] && ! mountpoint -q "$backup_mount"; then
    backup_error="${backup_mount} is not mounted"
    log "backup failed: ${backup_error}"
    return 1
  fi
  if ! mkdir -p "$backup_dir"; then
    backup_error="cannot create ${backup_dir}"
    return 1
  fi
  if ! release snapshot-db "$snapshot" "$homelab_snapshot"; then
    backup_error="database snapshot failed"
    ct_root rm -f "$snapshot" "$homelab_snapshot" || true
    return 1
  fi
  log "backing up ${state_dir} to ${backup_path}"
  local tar_rc=0
  ct_root tar -C "$service_home" -czf - \
    --exclude='.t3/userdata/state.sqlite' \
    --exclude='.t3/userdata/state.sqlite-wal' \
    --exclude='.t3/userdata/state.sqlite-shm' \
    --exclude='.t3/userdata/homelab.sqlite' \
    --exclude='.t3/userdata/homelab.sqlite-wal' \
    --exclude='.t3/userdata/homelab.sqlite-shm' \
    --exclude='.t3/userdata/provider-clis' \
    --exclude='.t3/userdata/logs' \
    --exclude='.t3/caches' \
    .t3 >"$backup_path" || tar_rc=$?
  ct_root rm -f "$snapshot" "$homelab_snapshot" || true
  # tar exits 1 when files changed while being read; that backup is still usable.
  if [[ "$tar_rc" -gt 1 ]]; then
    backup_error="tar failed with exit ${tar_rc}"
    log "backup ${backup_error}"
    rm -f "$backup_path"
    return 1
  fi
  chmod 0600 "$backup_path" || true
  log "backup complete: $(du -h "$backup_path" | awk '{print $1}')"
  prune_backups || log "pruning old backups failed (ignored)"
}

healthy() {
  local restarts_before restarts_after
  for _ in $(seq 1 30); do
    if ct_root systemctl is-active --quiet t3code.service &&
      ct_root curl -fsS -o /dev/null --max-time 5 "$health_url"; then
      # Still up and not crash-looping a few seconds later.
      restarts_before="$(ct_root systemctl show t3code.service -p NRestarts --value)"
      sleep 15
      restarts_after="$(ct_root systemctl show t3code.service -p NRestarts --value)"
      if [[ "$restarts_before" == "$restarts_after" ]] &&
        ct_root curl -fsS -o /dev/null --max-time 5 "$health_url"; then
        return 0
      fi
    fi
    sleep 3
  done
  return 1
}

exec 9>"$lock_path"
if ! flock -n 9; then
  log "another deployment is already running"
  exit 0
fi
trap record_run EXIT

if [[ -e "$pause_file" ]]; then
  log "deploys paused ($pause_file exists)"
  exit 0
fi

# Activating a release only matters if the service runs from `current`.
if ! ct_root systemctl cat t3code.service | grep -q "${releases_dir}/current/"; then
  log "t3code.service does not run from ${releases_dir}/current; install deploy/proxmox/t3code.service first"
  exit 1
fi

ct_t3 git -C "$source_dir" fetch --quiet --prune origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"

prepare_rc=0
prepare_out="$(release prepare)" || prepare_rc=$?
state="" target=""
read -r state target <<<"$prepare_out" || true
case "$state" in
  NOOP)
    exit 0
    ;;
  FAILED)
    log "origin/${branch} ${target:0:8} is marked failed (build, smoke, or health check); waiting for a new commit"
    alert high "Homelab Agent deploy failed: ${target:0:8}" \
      "Commit ${target:0:8} on ${branch} failed to build, smoke-test, or start, and will not be retried until ${branch} moves. Logs: ${logs_hint}"
    exit 1
    ;;
  READY) ;;
  "")
    if [[ "$prepare_rc" -ne 0 ]]; then
      # release.sh counts this attempt and reports FAILED (alerted above) once
      # the retries run out, so this run is not an unexplained failure.
      log "prepare failed (exit ${prepare_rc}); release.sh will retry this commit"
      alerted=1
    else
      log "unexpected empty prepare result"
    fi
    exit 1
    ;;
  *)
    log "unexpected prepare result: $state $target"
    exit 1
    ;;
esac

previous="$(release status | sed -n 's/^current=//p')"
log "deploying ${target:0:8} (current: ${previous:0:8})"

if ! backup_state; then
  alerted=1
  notify --key deploy-backup --id "$target" --every 0 --priority high --tags "floppy_disk,warning" \
    --title "Homelab Agent backup failed" \
    "Pre-deploy backup of ${state_dir} to ${backup_dir} failed (${backup_error:-see logs}); deploy of ${target:0:8} skipped and retried next run. Logs: ${logs_hint}"
  exit 1
fi
notify --resolve deploy-backup "Pre-deploy backups to ${backup_dir} work again."
release drain "$drain_max_seconds"
release activate "$target"

log "restarting t3code.service"
ct_root systemctl restart t3code.service
if healthy; then
  release prune "$releases_to_keep"
  log "deployment complete: ${target:0:8}"
  subject="$(ct_t3 git -C "$source_dir" log -1 --format=%s "$target" 2>/dev/null || true)"
  notify --resolve deploy "Deployed ${target:0:8}; the service is healthy."
  notify --priority low --tags "rocket" --title "Homelab Agent deployed ${target:0:8}" \
    "${target:0:8}${subject:+ ${subject}}"
  exit 0
fi

if [[ -z "$previous" ]]; then
  log "UNHEALTHY after deploying ${target:0:8} and there is no previous release to roll back to"
  alert urgent "Homelab Agent DOWN after deploy ${target:0:8}" \
    "t3code.service is unhealthy after deploying ${target:0:8} and there is no previous release to roll back to. Logs: ${logs_hint}"
  exit 1
fi
if release has-new-migrations "$previous" "$target"; then
  log "UNHEALTHY after deploying ${target:0:8}, which includes migrations: NOT rolling back automatically."
  log "Restore from the newest backup in ${backup_dir} or fix forward; touch ${pause_file} to stop retries."
  alert urgent "Homelab Agent DOWN after deploy ${target:0:8} (migration, no rollback)" \
    "${target:0:8} is unhealthy and includes migrations, so it was NOT rolled back. Restore from the newest backup in ${backup_dir} or fix forward; touch ${pause_file} to stop retries. Logs: ${logs_hint}"
  exit 1
fi
log "UNHEALTHY after deploying ${target:0:8}; rolling back to ${previous:0:8}"
release rollback
release mark-failed "$target"
ct_root systemctl restart t3code.service
if healthy; then
  log "rollback healthy on ${previous:0:8}"
  alert high "Homelab Agent deploy ${target:0:8} rolled back" \
    "${target:0:8} was unhealthy after restart; rolled back to ${previous:0:8}, which is healthy. ${target:0:8} will not be deployed again. Logs: ${logs_hint}"
else
  log "rollback ALSO unhealthy; manual attention needed"
  alert urgent "Homelab Agent DOWN: rollback to ${previous:0:8} also unhealthy" \
    "${target:0:8} was unhealthy after restart, and the rollback to ${previous:0:8} is unhealthy too. Manual attention needed. Logs: ${logs_hint}"
fi
exit 1
