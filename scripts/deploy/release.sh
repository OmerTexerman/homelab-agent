#!/usr/bin/env bash
# Release management for a Homelab Agent deployment host. Runs as the service
# user inside the deployment container; the host-side orchestrator
# (deploy/proxmox/homelab-agent-deploy.sh) calls these subcommands in order:
#
#   prepare                  build + smoke the target commit in its own release dir
#   snapshot-db <out> [homelab-out]
#                            consistent copy of state.sqlite (VACUUM INTO), and of
#                            homelab.sqlite into homelab-out when both exist
#   drain [max-seconds]      wait until no provider turn is running
#   activate <sha>           point `current` at a prepared release
#   rollback                 point `current` back at `previous`
#   mark-failed <sha>        never auto-deploy <sha> again (after a rollback)
#   has-new-migrations <a> <b>  exit 0 if commits a..b add or change migrations
#   prune [keep]             remove old release dirs (never current/previous)
#   status                   print current/previous/target
#
# The live release is never modified in place: a failed build or smoke leaves
# `current` untouched and the next run retries (up to a limit per commit).
set -Eeuo pipefail

source_dir="${HOMELAB_AGENT_SOURCE_DIR:-/opt/homelab-agent}"
releases_dir="${HOMELAB_AGENT_RELEASES_DIR:-$HOME/homelab-agent-releases}"
remote="${HOMELAB_AGENT_REMOTE:-origin}"
branch="${HOMELAB_AGENT_BRANCH:-prod}"
state_home="${T3CODE_HOME:-$HOME/.t3}"
max_attempts="${HOMELAB_AGENT_RELEASE_MAX_ATTEMPTS:-3}"
pnpm_bin="${HOMELAB_AGENT_PNPM:-pnpm}"
node_bin="${HOMELAB_AGENT_NODE:-node}"
migration_paths=(apps/server/src/persistence/Migrations apps/server/src/persistence/Migrations.ts)

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_db_helper="${HOMELAB_AGENT_STATE_DB_HELPER:-$script_dir/state-db.mjs}"
current_link="$releases_dir/current"
previous_link="$releases_dir/previous"

log() {
  printf '[release] %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

release_sha() {
  local link="$1"
  if [[ -L "$link" ]]; then
    basename "$(readlink "$link")"
  fi
}

swap_link() {
  local link="$1" target="$2"
  ln -sfn "$target" "$link.tmp"
  mv -T "$link.tmp" "$link"
}

state_db_path() {
  printf '%s/userdata/state.sqlite' "$state_home"
}

homelab_db_path() {
  printf '%s/userdata/homelab.sqlite' "$state_home"
}

cmd_prepare() {
  mkdir -p "$releases_dir"
  git -C "$source_dir" fetch --quiet --prune "$remote" "+refs/heads/${branch}:refs/remotes/${remote}/${branch}"
  local target
  target="$(git -C "$source_dir" rev-parse "${remote}/${branch}")"

  if [[ "$(release_sha "$current_link")" == "$target" ]]; then
    printf 'NOOP %s\n' "$target"
    return
  fi

  local dir="$releases_dir/$target"
  if [[ -f "$dir/.ready" ]]; then
    printf 'READY %s\n' "$target"
    return
  fi

  local attempts=0
  if [[ -f "$releases_dir/$target.attempts" ]]; then
    attempts="$(cat "$releases_dir/$target.attempts")"
  fi
  if (( attempts >= max_attempts )); then
    log "$target failed $attempts time(s); waiting for a new commit (delete $releases_dir/$target.attempts to retry)"
    printf 'FAILED %s\n' "$target"
    return
  fi
  printf '%s\n' "$((attempts + 1))" >"$releases_dir/$target.attempts"

  if [[ -d "$dir" ]]; then
    log "removing incomplete release dir $dir"
    git -C "$source_dir" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
  fi
  git -C "$source_dir" worktree prune
  log "preparing $target in $dir (attempt $((attempts + 1))/$max_attempts)"
  git -C "$source_dir" worktree add --quiet --detach "$dir" "$target"

  (
    cd "$dir"
    "$pnpm_bin" install --frozen-lockfile
    "$pnpm_bin" run build:prod
    if [[ -f "$(state_db_path)" ]]; then
      "$node_bin" scripts/prod-smoke.ts --seed-from "$state_home"
    else
      "$node_bin" scripts/prod-smoke.ts
    fi
  ) >&2

  touch "$dir/.ready"
  rm -f "$releases_dir/$target.attempts"
  printf 'READY %s\n' "$target"
}

# The optional second path stays compatible both ways: older release.sh copies
# ignore it, and a host without homelab.sqlite yet gets no file there.
cmd_snapshot_db() {
  local out="${1:?snapshot-db requires an output path}" homelab_out="${2:-}" db homelab_db
  db="$(state_db_path)"
  [[ -f "$db" ]] || die "no database at $db"
  rm -f "$out"
  "$node_bin" "$state_db_helper" snapshot "$db" "$out"
  if [[ -n "$homelab_out" ]]; then
    homelab_db="$(homelab_db_path)"
    rm -f "$homelab_out"
    if [[ -f "$homelab_db" ]]; then
      "$node_bin" "$state_db_helper" snapshot "$homelab_db" "$homelab_out"
    else
      log "no homelab database at $homelab_db; skipping its snapshot"
    fi
  fi
}

count_running_turns() {
  local db
  db="$(state_db_path)"
  if [[ ! -f "$db" ]]; then
    printf '0\n'
    return
  fi
  "$node_bin" "$state_db_helper" running-turns "$db"
}

cmd_drain() {
  local max_seconds="${1:-1200}" interval="${HOMELAB_AGENT_DRAIN_INTERVAL:-15}"
  local waited=0 running
  while true; do
    running="$(count_running_turns)"
    if [[ "$running" == "0" ]]; then
      log "no running turns"
      return
    fi
    if (( waited >= max_seconds )); then
      log "still $running running turn(s) after ${max_seconds}s; proceeding anyway"
      return
    fi
    log "waiting for $running running turn(s) to finish (${waited}s/${max_seconds}s)"
    sleep "$interval"
    waited=$((waited + interval))
  done
}

cmd_activate() {
  local sha="${1:?activate requires a sha}"
  local dir="$releases_dir/$sha"
  [[ -f "$dir/.ready" ]] || die "release $sha is not prepared"
  local current
  current="$(release_sha "$current_link")"
  if [[ "$current" == "$sha" ]]; then
    log "$sha is already current"
    return
  fi
  if [[ -n "$current" ]]; then
    swap_link "$previous_link" "$releases_dir/$current"
  fi
  swap_link "$current_link" "$dir"
  log "activated $sha (previous: ${current:-none})"
}

cmd_rollback() {
  local previous current
  previous="$(release_sha "$previous_link")"
  current="$(release_sha "$current_link")"
  [[ -n "$previous" ]] || die "no previous release to roll back to"
  swap_link "$current_link" "$releases_dir/$previous"
  if [[ -n "$current" ]]; then
    swap_link "$previous_link" "$releases_dir/$current"
  fi
  log "rolled back to $previous (was ${current:-none})"
}

# A release that failed its post-restart health check must not be re-prepared
# and re-activated on the next timer run.
cmd_mark_failed() {
  local sha="${1:?mark-failed requires a sha}"
  rm -f "$releases_dir/$sha/.ready"
  printf '%s\n' "$max_attempts" >"$releases_dir/$sha.attempts"
  log "marked $sha as failed; it will not be deployed again automatically"
}

cmd_has_new_migrations() {
  local from="${1:?has-new-migrations requires <from> <to>}" to="${2:?has-new-migrations requires <from> <to>}"
  [[ -n "$(git -C "$source_dir" diff --name-only "$from" "$to" -- "${migration_paths[@]}")" ]]
}

cmd_prune() {
  local keep="${1:-3}" current previous
  current="$(release_sha "$current_link")"
  previous="$(release_sha "$previous_link")"
  local kept=0 dir sha
  while IFS= read -r dir; do
    sha="$(basename "$dir")"
    if [[ "$sha" == "$current" || "$sha" == "$previous" ]]; then
      continue
    fi
    kept=$((kept + 1))
    if (( kept > keep )); then
      log "pruning release $sha"
      git -C "$source_dir" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
    fi
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  git -C "$source_dir" worktree prune
}

cmd_status() {
  printf 'current=%s\nprevious=%s\n' "$(release_sha "$current_link")" "$(release_sha "$previous_link")"
}

subcommand="${1:-}"
shift || true
case "$subcommand" in
  prepare) cmd_prepare "$@" ;;
  snapshot-db) cmd_snapshot_db "$@" ;;
  drain) cmd_drain "$@" ;;
  activate) cmd_activate "$@" ;;
  rollback) cmd_rollback "$@" ;;
  mark-failed) cmd_mark_failed "$@" ;;
  has-new-migrations) cmd_has_new_migrations "$@" ;;
  prune) cmd_prune "$@" ;;
  status) cmd_status "$@" ;;
  *)
    sed -n '2,19p' "$0" >&2
    exit 2
    ;;
esac
