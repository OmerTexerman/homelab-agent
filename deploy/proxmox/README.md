# Proxmox LXC deployment

How `ai.texerman.com` deploys. The app runs in LXC 201 on the Proxmox host as
user `t3code`; a host systemd timer runs `homelab-agent-deploy.sh` every ~5
minutes.

## Flow

1. CI passes on a `main` commit, and `.github/workflows/promote-prod.yml`
   fast-forwards `prod` to it. Deploys track `prod`, never `main`.
2. The host script runs `scripts/deploy/release.sh` taken from the `prod`
   commit, inside the container:
   - `prepare`: `git worktree add` the commit into
     `~/homelab-agent-releases/<sha>`, install, build, then run the production
     smoke against a `VACUUM INTO` copy of the real state (Docker stubbed out).
     The live release is never touched. A failing commit is retried up to 3
     times, then skipped until `prod` moves.
   - Back up `~/.t3` to the NAS (consistent DB snapshot, no caches or provider
     CLIs), keeping the newest 2.
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
| Ship while CI is broken | `gh workflow run promote-prod.yml -f sha=<main sha>`                                                                                                                                                                                                   |

Rolling back past a release that ran a migration needs a database restore
from the backup taken just before it.

## Installing or updating

Both files are copies of what's installed; keep them in sync.

1. Make sure `prod` exists and contains `scripts/deploy/release.sh` (CI green
   on `main` after this change, or a manual `promote-prod.yml` run).
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
