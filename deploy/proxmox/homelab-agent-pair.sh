#!/usr/bin/env bash
# Break-glass pairing for the Homelab Agent LXC. Installed on the Proxmox host
# as /usr/local/sbin/homelab-agent-pair.
#
# Mints a one-time pairing link inside the container (as the service user,
# against the live state) and prints it with a terminal QR code. Use it when no
# signed-in browser or passkey is at hand. The link grants admin access by
# default; pass --standard for a normal device link.
#
# Usage: homelab-agent-pair [--ttl 15m] [--standard] [--label TEXT]
set -Eeuo pipefail

ctid="${HOMELAB_AGENT_CTID:-201}"
service_home="${HOMELAB_AGENT_SERVICE_HOME:-/home/t3code}"
state_dir="$service_home/.t3"
release_dir="$service_home/homelab-agent-releases/current"
public_url="${HOMELAB_AGENT_PUBLIC_URL:-https://ai.texerman.com}"
ttl="15m"
admin="--admin"
label="Break-glass (Proxmox host)"

usage() {
  printf 'Usage: homelab-agent-pair [--ttl 15m] [--standard] [--label TEXT]\n'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ttl)
      ttl="${2:?--ttl needs a value, for example 15m}"
      shift 2
      ;;
    --standard)
      admin=""
      shift
      ;;
    --label)
      label="${2:?--label needs a value}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# `auth pairing create --json` prints pretty JSON with "pairUrl" and
# "expiresAt" on lines of their own.
issued="$(
  pct exec "$ctid" -- runuser -u t3code -- env \
    HOME="$service_home" \
    T3CODE_HOME="$state_dir" \
    /usr/bin/node "$release_dir/apps/server/dist/bin.mjs" auth pairing create \
    ${admin:+"$admin"} \
    --ttl "$ttl" \
    --label "$label" \
    --base-url "$public_url" \
    --base-dir "$state_dir" \
    --json
)"
json_field() {
  sed -n "s/^ *\"$1\": \"\(.*\)\",\{0,1\}\$/\1/p" <<<"$issued" | head -n 1
}
pair_url="$(json_field pairUrl)"
expires_at="$(json_field expiresAt)"
if [[ -z "$pair_url" ]]; then
  printf 'Could not create a pairing link. CLI output:\n%s\n' "$issued" >&2
  exit 1
fi

access="admin access"
[[ -z "$admin" ]] && access="standard access"
printf '\nPairing link (%s, one use, expires %s):\n\n  %s\n\n' "$access" "$expires_at" "$pair_url"
if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 "$pair_url"
else
  printf '(Install qrencode on this host to also print a QR code.)\n'
fi
