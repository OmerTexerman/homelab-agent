#!/usr/bin/env bash
# Restore drill for Homelab Agent backups. Installed on the Proxmox host as
# /usr/local/sbin/homelab-agent-restore-drill (optionally run monthly by
# homelab-agent-restore-drill.timer).
#
# Proves the newest backup can actually be restored, without touching live state:
#   1. reads the whole tarball (gzip CRC + tar structure) and lists it
#   2. checks free space inside the LXC and refuses if it is short
#   3. streams the top-level .t3/userdata files into a scratch dir inside the
#      LXC (never the live ~/.t3), renaming the *.backup.sqlite snapshots back
#   4. opens state.sqlite / homelab.sqlite read-only with node:sqlite, runs
#      PRAGMA integrity_check, and counts projects, threads, secrets, knowledge
#   5. unless --no-boot, runs the current release's scripts/prod-smoke.ts
#      --seed-from the restored copy (loopback port, Docker stubbed), which
#      checks /api/auth/session and that the knowledge graph loads intact
#   6. removes the scratch dir, prints a summary, and notifies with the result
#
# Holds the deploy lock while it runs, so a deploy can't prune or write the
# backup being read. Usage: homelab-agent-restore-drill [--backup PATH] [--no-boot]
set -Eeuo pipefail

ctid="${HOMELAB_AGENT_CTID:-201}"
service_home="${HOMELAB_AGENT_SERVICE_HOME:-/home/t3code}"
backup_dir="${HOMELAB_AGENT_BACKUP_DIR:-/mnt/pve/nas-backups/homelab-agent}"
deploy_lock="${HOMELAB_AGENT_DEPLOY_LOCK:-/run/homelab-agent-ai-agent-deploy.lock}"
notify_bin="${HOMELAB_AGENT_NOTIFY:-/usr/local/sbin/homelab-agent-notify}"
# Scratch space inside the LXC; it shares the root disk with the live app.
scratch_parent="${HOMELAB_AGENT_DRILL_DIR:-/var/tmp}"
reserve_bytes="${HOMELAB_AGENT_DRILL_RESERVE_BYTES:-$((3 * 1024 * 1024 * 1024))}"
smoke_timeout="${HOMELAB_AGENT_DRILL_SMOKE_TIMEOUT:-15m}"
release_link="$service_home/homelab-agent-releases/current"

backup="" boot=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) backup="${2:?--backup needs a path}"; shift 2 ;;
    --no-boot) boot=0; shift ;;
    -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

log() {
  printf '[homelab-agent-restore-drill] %s\n' "$*" >&2
}

notify() {
  if [[ -x "$notify_bin" ]]; then
    "$notify_bin" "$@" || true
  else
    log "notify skipped ($notify_bin not installed)"
  fi
}

ct() {
  pct exec "$ctid" -- "$@"
}

ct_t3() {
  pct exec "$ctid" -- runuser -u t3code -- env -u T3CODE_HOME \
    HOME="$service_home" \
    PATH="$service_home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

summary=()
scratch=""
failing=0

fail() {
  ((failing)) && exit 1
  failing=1
  log "FAILED: $*"
  printf '%s\n' "${summary[@]}" >&2
  notify --priority high --tags "x,floppy_disk" --title "Homelab Agent restore drill FAILED" \
    "$* | $(IFS='; '; printf '%s' "${summary[*]}")"
  exit 1
}

cleanup() {
  # Only ever remove the scratch dir this run created.
  if [[ "$scratch" == "$scratch_parent"/homelab-agent-restore-drill.* ]]; then
    ct rm -rf -- "$scratch" || log "could not remove $scratch inside LXC $ctid"
  fi
}
trap cleanup EXIT
trap 'fail "unexpected error on line $LINENO"' ERR

exec 9>"$deploy_lock"
if ! flock -n 9; then
  log "a deploy is running; try again later"
  exit 1
fi

if [[ -z "$backup" ]]; then
  backup="$(find "$backup_dir" -maxdepth 1 -name 't3code-home-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | head -n 1 | cut -d' ' -f2-)" || true
fi
[[ -n "$backup" && -f "$backup" ]] || fail "no backup found in $backup_dir"
backup_age_h=$((($(date +%s) - $(stat -c %Y "$backup")) / 3600))
summary+=("backup $(basename "$backup") ($(du -h "$backup" | cut -f1), ${backup_age_h}h old)")
log "drilling ${backup}"

# Reading the full listing verifies every gzip block and tar header.
listing="$(tar -tvzf "$backup")" || fail "cannot read $(basename "$backup"): archive is corrupt or truncated"
# Restore only top-level userdata files (databases + JSON stores); runtime
# workspaces and secrets stay in the archive.
members=() need_bytes=0 db_bytes=0
while read -r perms _owner size _date _time name; do
  [[ "$perms" == -* && "$name" =~ ^\.t3/userdata/[^/]+$ ]] || continue
  members+=("$name")
  need_bytes=$((need_bytes + size))
  [[ "$name" == *.backup.sqlite ]] && db_bytes=$((db_bytes + size))
done <<<"$listing"
summary+=("archive ok: $(wc -l <<<"$listing") entries")
has_member() {
  local member
  for member in "${members[@]}"; do
    [[ "$member" == "$1" ]] && return 0
  done
  return 1
}
has_member .t3/userdata/state.backup.sqlite || fail "backup has no .t3/userdata/state.backup.sqlite snapshot"

# The smoke copies the databases once more (VACUUM INTO its own temp home).
((boot)) && need_bytes=$((need_bytes + db_bytes))
avail_bytes="$(ct df -P -B1 "$scratch_parent" | awk 'NR == 2 { print $4 }')"
[[ "$avail_bytes" =~ ^[0-9]+$ ]] || fail "cannot read free space of $scratch_parent inside LXC $ctid"
if ((avail_bytes < need_bytes + reserve_bytes)); then
  fail "not enough space in LXC $ctid $scratch_parent: need $((need_bytes / 1048576)) MiB + $((reserve_bytes / 1048576)) MiB reserve, have $((avail_bytes / 1048576)) MiB"
fi

scratch="$(ct_t3 mktemp -d -p "$scratch_parent" homelab-agent-restore-drill.XXXXXX)"
[[ "$scratch" == "$scratch_parent"/homelab-agent-restore-drill.* ]] || fail "unexpected scratch dir: $scratch"
ct_t3 mkdir -p "$scratch/tmp"
log "restoring ${#members[@]} file(s) into LXC ${ctid}:${scratch}"
ct_t3 tar -xzf - -C "$scratch" -- "${members[@]}" <"$backup" || fail "extracting into $scratch failed"
userdata="$scratch/.t3/userdata"
ct_t3 mv "$userdata/state.backup.sqlite" "$userdata/state.sqlite"
if has_member .t3/userdata/homelab.backup.sqlite; then
  ct_t3 mv "$userdata/homelab.backup.sqlite" "$userdata/homelab.sqlite"
fi

# Read-only integrity check and row counts. Prints one line per database.
# shellcheck disable=SC2016 # JavaScript, not shell
verify_js='
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const counts = {
  "state.sqlite": { projects: "projection_projects", threads: "projection_threads", messages: "projection_thread_messages" },
  "homelab.sqlite": { secrets: "homelab_secrets", knowledge: "knowledge_docs", runtimes: "runtimes" },
};
let ok = true;
for (const [name, tables] of Object.entries(counts)) {
  const path = `${process.argv[1]}/${name}`;
  if (!fs.existsSync(path)) { console.log(`${name}: absent`); continue; }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]);
    const integrity = rows.length === 1 && rows[0] === "ok" ? "ok" : rows.slice(0, 3).join(" | ");
    if (integrity !== "ok") ok = false;
    const parts = [`integrity ${integrity}`];
    for (const [label, table] of Object.entries(tables)) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", table);
      parts.push(`${label} ${exists ? db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n : "n/a"}`);
    }
    console.log(`${name}: ${parts.join(", ")}`);
  } finally {
    db.close();
  }
}
process.exit(ok ? 0 : 1);
'
verify_rc=0
verify_out="$(ct_t3 node -e "$verify_js" "$userdata" 2>&1)" || verify_rc=$?
while IFS= read -r line; do
  [[ -n "$line" ]] && summary+=("$line")
done <<<"$verify_out"
((verify_rc == 0)) || fail "database integrity check failed"

if ((boot)); then
  release_dir="$(ct readlink -f "$release_link")"
  [[ -n "$release_dir" ]] || fail "no current release at $release_link"
  log "booting $(basename "$release_dir") against the restored copy (Docker disabled)"
  started=$(date +%s)
  smoke_rc=0
  # shellcheck disable=SC2016 # expanded by the inner bash
  smoke_out="$(ct_t3 TMPDIR="$scratch/tmp" timeout "$smoke_timeout" \
    bash -c 'cd "$1" && exec node scripts/prod-smoke.ts --seed-from "$2"' smoke "$release_dir" "$scratch/.t3" 2>&1)" ||
    smoke_rc=$?
  if ((smoke_rc != 0)); then
    printf '%s\n' "$smoke_out" | tail -n 40 >&2
    fail "release $(basename "$release_dir" | cut -c1-8) did not boot against the restored state (exit $smoke_rc)"
  fi
  graph_line="$(grep -o 'Seeded knowledge graph loaded intact ([0-9]* entities)' <<<"$smoke_out" || true)"
  summary+=("booted $(basename "$release_dir" | cut -c1-8) in $(($(date +%s) - started))s, /api/auth/session ok${graph_line:+, ${graph_line#Seeded }}")
else
  summary+=("boot skipped (--no-boot)")
fi

trap - ERR
log "PASSED"
printf '%s\n' "${summary[@]}"
notify --priority default --tags "white_check_mark,floppy_disk" --title "Homelab Agent restore drill passed" \
  "$(printf '%s\n' "${summary[@]}")"
