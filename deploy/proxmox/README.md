# Proxmox LXC deployment

How `ai.texerman.com` deploys. The app runs in LXC 201 on the Proxmox host as
user `t3code`; a host systemd timer runs `homelab-agent-deploy.sh` every ~5
minutes.

## Flow

1. `CI` and `Runtime smoke` (real runtime containers plus a Chromium pass over
   the web app) both pass on a `main` commit, and
   `.github/workflows/promote-prod.yml` fast-forwards `prod` to it. Each
   workflow's completion runs the promotion, which waits for the other one to
   have succeeded for the same commit. Deploys track `prod`, never `main`.
2. The host script runs `scripts/deploy/release.sh` taken from the `prod`
   commit, inside the container:
   - `prepare`: `git worktree add` the commit into
     `~/homelab-agent-releases/<sha>`, install, build, then run the production
     smoke against a `VACUUM INTO` copy of the real state (`state.sqlite`, plus
     the fork's `homelab.sqlite` when present; Docker stubbed out).
     The live release is never touched. A failing commit is retried up to 3
     times, then skipped until `prod` moves.
   - Back up `~/.t3` to the NAS, keeping the newest 2. The live `state.sqlite`
     and `homelab.sqlite` files are excluded and replaced by consistent
     snapshots (`userdata/state.backup.sqlite`, `userdata/homelab.backup.sqlite`);
     caches and provider CLIs are skipped.
   - `drain`: wait up to 20 minutes for running turns to finish.
   - `activate`: switch `current` to the new release (`previous` keeps the old one).
3. Restart `t3code.service`, which runs from `current`.
4. Health check: the service is active, `/api/auth/session` answers, and it isn't
   crash-looping.
   - If unhealthy and the release added no migration: roll back to `previous`
     and restart.
   - If it added a migration: stop and log, because older code can't read a
     migrated database. Restore from backup or fix forward.

## Operating

| Task                    | Command (on the Proxmox host)                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pause deploys           | `touch /etc/homelab-agent/deploy.paused`                                                                                                                                                                                                               |
| Resume                  | `rm /etc/homelab-agent/deploy.paused`                                                                                                                                                                                                                  |
| Status                  | `pct exec 201 -- ls -l /home/t3code/homelab-agent-releases`                                                                                                                                                                                            |
| Logs                    | `journalctl -u homelab-agent-ai-agent-autodeploy.service -n 200`                                                                                                                                                                                       |
| Roll back               | `touch /etc/homelab-agent/deploy.paused`, then `pct exec 201 -- runuser -u t3code -- env HOME=/home/t3code bash /home/t3code/homelab-agent-releases/current/scripts/deploy/release.sh rollback` and `pct exec 201 -- systemctl restart t3code.service` |
| Retry a failed commit   | `pct exec 201 -- rm /home/t3code/homelab-agent-releases/<sha>.attempts`                                                                                                                                                                                |
| Ship while CI is broken | `gh workflow run promote-prod.yml -f sha=<main sha>` (skips both the CI and Runtime smoke gates)                                                                                                                                                       |

### Break-glass pairing

When no signed-in browser or passkey is at hand, mint a one-time admin
pairing link from the Proxmox host:

```bash
homelab-agent-pair                 # admin link, valid 15 minutes
homelab-agent-pair --ttl 5m        # shorter
homelab-agent-pair --standard      # a normal device link (no device/secret management)
```

It runs `bin.mjs auth pairing create --admin --ttl 15m --base-url https://ai.texerman.com --base-dir /home/t3code/.t3 --json`
inside LXC 201 as `t3code` against the live state (the running server keeps
serving), then prints the `https://ai.texerman.com/pair#token=...` link and,
when `qrencode` is installed on the host (`apt install qrencode`), a terminal
QR code. The link shows up in Settings -> Devices & Sessions and can be revoked
there. Override the container or URL with `HOMELAB_AGENT_CTID` and
`HOMELAB_AGENT_PUBLIC_URL`.

Install or update it with:

```bash
install -m 0755 deploy/proxmox/homelab-agent-pair.sh /usr/local/sbin/homelab-agent-pair
```

Rolling back past a release that ran a `state.sqlite` migration needs a
database restore from the backup taken just before it. `homelab.sqlite`
migrations are additive and leave their JSON sources intact, so they don't
block an automatic rollback (see `docs/internals/homelab-storage.md`). To
restore either database, stop the service and copy its `*.backup.sqlite` from
the backup over the live file, deleting the live `-wal` and `-shm` siblings.

## Alerts, health checks, and restore drills

Everything here runs on the Proxmox host, not in the app, so alerts still go
out when the app or the whole LXC is down. Alerts go to an
[ntfy](https://ntfy.sh) topic (ntfy.sh or self-hosted); subscribe to it in the
ntfy phone app.

- `homelab-agent-notify` sends one alert. With `--key`, an alert is a
  condition: the same key is sent at most once every `NOTIFY_REPEAT_HOURS`
  (default 12), again right away if its priority goes up or its `--id`
  changes, and a "Resolved" message follows once the condition clears. State
  lives in `/var/lib/homelab-agent/notify/`. It never fails its caller.
- `homelab-agent-deploy-ai-agent.sh` alerts on:
  - **high**: a commit that failed build/smoke 3 times (once per commit), a
    failed pre-deploy backup (deploy skipped), a rollback after an unhealthy
    restart
  - **urgent**: unhealthy with no previous release, unhealthy with a
    migration (no rollback), rollback also unhealthy
  - **low**: each successful deploy (short sha + commit subject)

  Runs that fail without one of these alerts (fetch errors, script errors) are
  counted in `/var/lib/homelab-agent/deploy-failures`; the health check alerts
  after 3 in a row. The pre-deploy backup now refuses to run when
  `/mnt/pve/nas-backups` is not mounted, instead of filling the host disk.

- `homelab-agent-health` (every 15 minutes) checks: the LXC is running; its
  root disk (high at 85%, urgent at 95%); `t3code.service` is active, answers
  `/api/auth/session`, and is not auto-restarting; the public URL answers from
  the host; the NAS backup mount is present and writable and the newest backup
  is under 8 days old; the certificate `ai.texerman.com:443` actually serves
  has 14+ days left (read with `openssl s_client`, so a renewed cert the proxy
  never reloaded still alerts); the autodeploy timer is active; and Docker
  images plus build cache inside the LXC stay under 20 GB with fewer than 10
  dangling images (low priority). Service checks are skipped while a deploy
  holds the deploy lock. Thresholds are `HEALTH_*` lines in `notify.env`.
- `homelab-agent-restore-drill` (monthly, or by hand) proves the newest backup
  restores: it reads the whole tarball, checks free space in the LXC (refuses
  when short), extracts the top-level `.t3/userdata` files into a scratch dir
  under `/var/tmp` in the LXC, runs `PRAGMA integrity_check` on `state.sqlite`
  and `homelab.sqlite` (read-only) and counts projects, threads, secrets, and
  knowledge docs, then boots the current release against that copy with
  `scripts/prod-smoke.ts --seed-from` (loopback port, Docker disabled). It
  holds the deploy lock, deletes the scratch dir, and notifies the result.
  Live state is never touched. `--no-boot` skips the boot; `--backup PATH`
  drills a specific tarball.

Install or update them on the Proxmox host, from a checkout of this repo:

```bash
install -m 0755 deploy/proxmox/homelab-agent-notify.sh /usr/local/sbin/homelab-agent-notify
install -m 0755 deploy/proxmox/homelab-agent-health.sh /usr/local/sbin/homelab-agent-health
install -m 0755 deploy/proxmox/homelab-agent-restore-drill.sh /usr/local/sbin/homelab-agent-restore-drill
install -m 0755 deploy/proxmox/homelab-agent-deploy.sh /usr/local/sbin/homelab-agent-deploy-ai-agent.sh
install -m 0644 deploy/proxmox/homelab-agent-health.{service,timer} /etc/systemd/system/
install -m 0644 deploy/proxmox/homelab-agent-restore-drill.{service,timer} /etc/systemd/system/

mkdir -p /etc/homelab-agent /var/lib/homelab-agent
# Only the first time; then set NTFY_URL (and NTFY_TOKEN for a protected topic):
[ -e /etc/homelab-agent/notify.env ] || install -m 0600 deploy/proxmox/notify.env.example /etc/homelab-agent/notify.env
"${EDITOR:-nano}" /etc/homelab-agent/notify.env

homelab-agent-notify --title "Homelab Agent test" "Alerts from $(hostname) work."
systemctl daemon-reload
systemctl enable --now homelab-agent-health.timer homelab-agent-restore-drill.timer
systemctl start homelab-agent-health.service && journalctl -u homelab-agent-health.service -n 30
homelab-agent-restore-drill        # first drill by hand; takes a few minutes
```

Without `/etc/homelab-agent/notify.env` (or with `NTFY_URL` empty) every
script still runs and logs `alerts disabled` instead of sending.

| Task                         | Command (on the Proxmox host)                                    |
| ---------------------------- | ---------------------------------------------------------------- |
| Health check now             | `systemctl start homelab-agent-health.service`                   |
| Health log                   | `journalctl -u homelab-agent-health.service -n 100`              |
| Restore drill now            | `homelab-agent-restore-drill` (`--no-boot` for the quick checks) |
| See raised alerts            | `ls /var/lib/homelab-agent/notify/`                              |
| Forget an alert (re-sends)   | `rm /var/lib/homelab-agent/notify/<key>.state`                   |
| Clear the deploy fail streak | `rm /var/lib/homelab-agent/deploy-failures`                      |

## Installing or updating

The files here are copies of what's installed; keep them in sync.

1. Make sure `prod` exists and contains `scripts/deploy/release.sh` (CI and
   Runtime smoke green on `main` after this change, or a manual
   `promote-prod.yml` run).
2. On the Proxmox host, back up the current script and unit, then install:
   ```bash
   cp /usr/local/sbin/homelab-agent-deploy-ai-agent.sh{,.bak}
   pct exec 201 -- cp /etc/systemd/system/t3code.service /etc/systemd/system/t3code.service.bak
   touch /etc/homelab-agent/deploy.paused   # mkdir -p /etc/homelab-agent first
   ```
3. Prepare the first release by hand, then switch the unit to it:
   ```bash
   pct exec 201 -- runuser -u t3code -- env HOME=/home/t3code bash -lc 'cd /opt/homelab-agent && git fetch origin prod && \
     HOMELAB_AGENT_SOURCE_DIR=/opt/homelab-agent T3CODE_HOME=/home/t3code/.t3 \
     bash <(git show origin/prod:scripts/deploy/release.sh) prepare'
   # activate the printed sha, install the unit, restart:
   pct exec 201 -- runuser -u t3code -- env HOME=/home/t3code bash -lc 'bash <(git -C /opt/homelab-agent show origin/prod:scripts/deploy/release.sh) activate <sha>'
   pct push 201 deploy/proxmox/t3code.service /etc/systemd/system/t3code.service
   pct exec 201 -- systemctl daemon-reload
   pct exec 201 -- systemctl restart t3code.service
   ```
4. Install the host script and resume:
   ```bash
   install -m 0755 deploy/proxmox/homelab-agent-deploy.sh /usr/local/sbin/homelab-agent-deploy-ai-agent.sh
   rm /etc/homelab-agent/deploy.paused
   ```
5. Install alerts, health checks, and the restore drill (see
   [Alerts, health checks, and restore drills](#alerts-health-checks-and-restore-drills)).
