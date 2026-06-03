#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-main.sh [--dry-run] [--force]

Fast-forward a deployment checkout to origin/main, build production assets, run
the disposable production smoke, back up T3CODE_HOME, and restart the Homelab
Agent service.

Environment:
  HOMELAB_AGENT_REPO_DIR          Repository checkout. Default: current directory.
  HOMELAB_AGENT_REMOTE            Git remote to fetch. Default: origin.
  HOMELAB_AGENT_BRANCH            Branch to deploy. Default: main.
  HOMELAB_AGENT_SERVICE           Service name to restart. Default: homelab-agent.service.
  HOMELAB_AGENT_SERVICE_MANAGER   user, system, or none. Default: user.
  HOMELAB_AGENT_SKIP_INSTALL      Set 1 to skip bun install --frozen-lockfile.
  HOMELAB_AGENT_SKIP_SMOKE        Set 1 to skip bun run smoke:prod.
  HOMELAB_AGENT_SKIP_BACKUP       Set 1 to skip T3CODE_HOME backup.
  HOMELAB_AGENT_BACKUP_DIR        Backup parent directory. Default: sibling <T3CODE_HOME>.backups.
  T3CODE_HOME                     Persistent state directory to back up.

The script never hard-resets local changes. The deployment checkout must be
clean and able to fast-forward to the remote branch.
EOF
}

dry_run=0
force=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=1
      ;;
    --force)
      force=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_dir="${HOMELAB_AGENT_REPO_DIR:-$PWD}"
remote="${HOMELAB_AGENT_REMOTE:-origin}"
branch="${HOMELAB_AGENT_BRANCH:-main}"
service="${HOMELAB_AGENT_SERVICE:-homelab-agent.service}"
service_manager="${HOMELAB_AGENT_SERVICE_MANAGER:-user}"
skip_install="${HOMELAB_AGENT_SKIP_INSTALL:-0}"
skip_smoke="${HOMELAB_AGENT_SKIP_SMOKE:-0}"
skip_backup="${HOMELAB_AGENT_SKIP_BACKUP:-0}"
lock_path="${HOMELAB_AGENT_DEPLOY_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/homelab-agent-deploy.lock}"

log() {
  printf '[deploy-main] %s\n' "$*"
}

run() {
  log "+ $*"
  if [[ "$dry_run" != "1" ]]; then
    "$@"
  fi
}

require_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short >&2
    echo "Deployment checkout has local changes; refusing to deploy." >&2
    exit 1
  fi
}

restart_service() {
  case "$service_manager" in
    user)
      run systemctl --user restart "$service"
      ;;
    system)
      run systemctl restart "$service"
      ;;
    none)
      log "Skipping service restart because HOMELAB_AGENT_SERVICE_MANAGER=none."
      ;;
    *)
      echo "Invalid HOMELAB_AGENT_SERVICE_MANAGER: $service_manager" >&2
      exit 2
      ;;
  esac
}

backup_state() {
  if [[ "$skip_backup" == "1" ]]; then
    log "Skipping backup because HOMELAB_AGENT_SKIP_BACKUP=1."
    return
  fi

  if [[ -z "${T3CODE_HOME:-}" ]]; then
    echo "T3CODE_HOME is required for deployment backups. Set HOMELAB_AGENT_SKIP_BACKUP=1 to bypass." >&2
    exit 1
  fi

  if [[ ! -d "$T3CODE_HOME" ]]; then
    log "T3CODE_HOME does not exist yet; no backup created: $T3CODE_HOME"
    return
  fi

  local timestamp backup_parent backup_path
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_parent="${HOMELAB_AGENT_BACKUP_DIR:-${T3CODE_HOME}.backups}"
  backup_path="${backup_parent}/${timestamp}"
  run mkdir -p "$backup_parent"
  run cp -a "$T3CODE_HOME" "$backup_path"
  log "Backed up T3CODE_HOME to $backup_path"
}

exec 9>"$lock_path"
if ! flock -n 9; then
  echo "Another deployment is already running: $lock_path" >&2
  exit 1
fi

cd "$repo_dir"
require_clean_worktree

current_head="$(git rev-parse HEAD)"
run git fetch --prune "$remote" "+refs/heads/${branch}:refs/remotes/${remote}/${branch}"
target_ref="$remote/$branch"
target_head="$(git rev-parse "$target_ref")"

if [[ "$current_head" == "$target_head" && "$force" != "1" ]]; then
  log "Already at $target_ref ($target_head); nothing to deploy."
  exit 0
fi

if ! git merge-base --is-ancestor "$current_head" "$target_head"; then
  echo "Current HEAD is not an ancestor of $target_ref; refusing non-fast-forward deployment." >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$branch" ]]; then
  run git checkout "$branch"
fi

run git merge --ff-only "$target_ref"

if [[ "$skip_install" != "1" ]]; then
  run bun install --frozen-lockfile
fi

run bun run build:prod

if [[ "$skip_smoke" != "1" ]]; then
  run bun run smoke:prod
fi

backup_state
restart_service
log "Deployment complete: $(git rev-parse --short HEAD)"
