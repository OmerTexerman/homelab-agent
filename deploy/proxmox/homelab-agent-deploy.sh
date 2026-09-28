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
set -Eeuo pipefail

ctid="${HOMELAB_AGENT_CTID:-201}"
service_home="${HOMELAB_AGENT_SERVICE_HOME:-/home/t3code}"
source_dir="${HOMELAB_AGENT_SOURCE_DIR:-/opt/homelab-agent}"
branch="${HOMELAB_AGENT_BRANCH:-prod}"
state_dir="$service_home/.t3"
releases_dir="$service_home/homelab-agent-releases"
backup_dir="${HOMELAB_AGENT_BACKUP_DIR:-/mnt/pve/nas-backups/homelab-agent}"
backups_to_keep="2"
releases_to_keep="3"
drain_max_seconds="${HOMELAB_AGENT_DRAIN_MAX_SECONDS:-1200}"
health_url="http://127.0.0.1:3000/api/auth/session"
lock_path="${HOMELAB_AGENT_DEPLOY_LOCK:-/run/homelab-agent-ai-agent-deploy.lock}"
pause_file="${HOMELAB_AGENT_PAUSE_FILE:-/etc/homelab-agent/deploy.paused}"

log() {
  printf '[homelab-agent-deploy] %s\n' "$*"
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

# Backs up everything except the live database files (replaced by a consistent
# VACUUM INTO snapshot) and reinstallable caches.
backup_state() {
  local timestamp backup_path snapshot="$state_dir/userdata/state.backup.sqlite"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="${backup_dir}/t3code-home-${timestamp}.tar.gz"
  mkdir -p "$backup_dir"
  release snapshot-db "$snapshot"
  log "backing up ${state_dir} to ${backup_path}"
  set +e
  ct_root tar -C "$service_home" -czf - \
    --exclude='.t3/userdata/state.sqlite' \
    --exclude='.t3/userdata/state.sqlite-wal' \
    --exclude='.t3/userdata/state.sqlite-shm' \
    --exclude='.t3/userdata/provider-clis' \
    --exclude='.t3/userdata/logs' \
    --exclude='.t3/caches' \
    .t3 >"$backup_path"
  local tar_rc=${PIPESTATUS[0]}
  set -e
  ct_root rm -f "$snapshot"
  if [[ "$tar_rc" -gt 1 ]]; then
    log "backup tar failed with exit ${tar_rc}"
    rm -f "$backup_path"
    return 1
  fi
  chmod 0600 "$backup_path"
  log "backup complete: $(du -h "$backup_path" | awk '{print $1}')"
  prune_backups
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

read -r state target < <(release prepare)
case "$state" in
  NOOP)
    exit 0
    ;;
  FAILED)
    log "origin/${branch} ${target:0:8} is marked failed (build, smoke, or health check); waiting for a new commit"
    exit 1
    ;;
  READY) ;;
  *)
    log "unexpected prepare result: $state $target"
    exit 1
    ;;
esac

previous="$(release status | sed -n 's/^current=//p')"
log "deploying ${target:0:8} (current: ${previous:0:8})"

backup_state
release drain "$drain_max_seconds"
release activate "$target"

log "restarting t3code.service"
ct_root systemctl restart t3code.service
if healthy; then
  release prune "$releases_to_keep"
  log "deployment complete: ${target:0:8}"
  exit 0
fi

if [[ -z "$previous" ]]; then
  log "UNHEALTHY after deploying ${target:0:8} and there is no previous release to roll back to"
  exit 1
fi
if release has-new-migrations "$previous" "$target"; then
  log "UNHEALTHY after deploying ${target:0:8}, which includes migrations: NOT rolling back automatically."
  log "Restore from the newest backup in ${backup_dir} or fix forward; touch ${pause_file} to stop retries."
  exit 1
fi
log "UNHEALTHY after deploying ${target:0:8}; rolling back to ${previous:0:8}"
release rollback
release mark-failed "$target"
ct_root systemctl restart t3code.service
healthy && log "rollback healthy on ${previous:0:8}" || log "rollback ALSO unhealthy; manual attention needed"
exit 1
