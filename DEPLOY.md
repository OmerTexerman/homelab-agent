# Homelab Agent V3 — Deployment Guide

Complete guide for deploying homelab-agent-v3 on a Proxmox LXC. This document
contains everything needed to go from a fresh Debian LXC to a running instance.

## Target Environment

- **LXC 201** "ai-agent" on Proxmox at 192.168.3.173
- Debian 12+, 8GB RAM, 4 cores
- Docker, Bun, Node.js 24, Claude Code CLI, nginx, certbot
- Internal DNS: ai.texerman.com -> 192.168.3.173
- SSL via certbot with Cloudflare DNS challenge

## Architecture

```
Browser -> https://ai.texerman.com
        -> nginx (SSL termination, WebSocket proxy)
        -> Bun server (port 3000)
           -> spawns Docker containers per thread
           -> Claude Code / Codex run INSIDE containers
           -> containers have SSH, curl, CLI tools
           -> homelab CLI talks back to server API
```

## Prerequisites on the LXC

```bash
# System packages
apt-get update && apt-get install -y curl wget git ssh jq python3 \
  htop tmux vim nano unzip ca-certificates gnupg lsb-release \
  dnsutils net-tools nmap rsync nginx certbot python3-certbot-dns-cloudflare

# Bun
curl -fsSL https://bun.sh/install | bash

# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Codex CLI
npm install -g @openai/codex

# Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
```

## Service User

The server MUST run as a non-root user. Claude Code refuses
`--dangerously-skip-permissions` (used by "Full Access" mode) when running as
root.

```bash
useradd -m -s /bin/bash t3code
usermod -aG docker t3code
```

## Provider Authentication

Authenticate Claude Code and Codex as the `t3code` user:

```bash
su - t3code
claude          # Follow the OAuth login flow in browser
codex login     # Follow the OAuth login flow
exit
```

The credentials live in `/home/t3code/.claude/` and `/home/t3code/.codex/`.

**Do NOT set ANTHROPIC_API_KEY in the environment.** If present, Claude Code
uses the API key instead of the OAuth login, and the API key may have
insufficient credits. The OAuth login uses the user's Claude subscription.

## Build & Deploy

```bash
# Clone or rsync the repo to /opt/t3code
cd /opt/t3code
bun install
bun run build

# Build the runtime Docker image (used for thread containers)
docker build -t homelab-agent-runtime -f docker/runtime/Dockerfile .

# Fix ownership
chown -R t3code:t3code /opt/t3code
```

## Systemd Service

```ini
# /etc/systemd/system/t3code.service
[Unit]
Description=Homelab Agent V3
After=network.target docker.service

[Service]
Type=simple
User=t3code
Group=t3code
WorkingDirectory=/opt/t3code
Environment=HOME=/home/t3code
Environment=BUN_INSTALL=/home/t3code/.bun
Environment=PATH=/home/t3code/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=T3CODE_PORT=3000
Environment=T3CODE_HOST=0.0.0.0
Environment=T3CODE_DOCKER_ENABLED=true
Environment=T3CODE_DOCKER_IMAGE=homelab-agent-runtime
ExecStart=/home/t3code/.bun/bin/bun /opt/t3code/apps/server/dist/bin.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now t3code
```

## Nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/t3code.conf
server {
    listen 80;
    server_name ai.texerman.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ai.texerman.com;

    ssl_certificate /etc/letsencrypt/live/ai.texerman.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.texerman.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/t3code.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
systemctl restart nginx
```

## SSL Certificate

Using certbot with Cloudflare DNS challenge (works for internal-only domains):

```bash
# Create Cloudflare credentials file
mkdir -p /root/.secrets
cat > /root/.secrets/cloudflare.ini << 'EOF'
dns_cloudflare_api_token = YOUR_CLOUDFLARE_API_TOKEN
EOF
chmod 600 /root/.secrets/cloudflare.ini

# Get certificate
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d ai.texerman.com
```

## First Run — Pairing

After starting the service, check the logs for the pairing URL:

```bash
journalctl -u t3code -n 10 | grep pairingUrl
```

Open the pairing URL in your browser to authenticate. The URL looks like:
`https://ai.texerman.com/pair#token=XXXXXXXXXXXX`

## Host Directory Structure

```
/opt/t3code/              # The application (repo clone)
/home/t3code/.claude/     # Claude Code OAuth credentials
/home/t3code/.codex/      # Codex OAuth credentials
/home/t3code/.bun/        # Bun runtime
/home/t3code/.t3/         # T3 Code state (SQLite DB, logs, settings)
```

## Environment Variables Reference

| Variable                | Required | Description                                        |
| ----------------------- | -------- | -------------------------------------------------- |
| `HOME`                  | Yes      | Must be `/home/t3code` for credential discovery    |
| `T3CODE_PORT`           | Yes      | Server port (3000)                                 |
| `T3CODE_HOST`           | Yes      | Bind address (0.0.0.0)                             |
| `T3CODE_DOCKER_ENABLED` | Yes      | Enable container isolation (`true`)                |
| `T3CODE_DOCKER_IMAGE`   | Yes      | Docker image for threads (`homelab-agent-runtime`) |

**Do NOT set** `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the service
environment. Provider auth uses OAuth logins stored in the home directory.
API keys for infrastructure services (TrueNAS, Cloudflare, etc.) are managed
through the platform's secret broker, not environment variables.

## Updating

```bash
# Rsync or git pull new code
cd /opt/t3code
bun install
bun run build
chown -R t3code:t3code /opt/t3code
systemctl restart t3code

# If docker/runtime/Dockerfile changed:
docker build -t homelab-agent-runtime -f docker/runtime/Dockerfile .
```

## Troubleshooting

| Problem                                                   | Fix                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| "Claude Code process exited with code 1"                  | Check `journalctl -u t3code`. Usually a permissions or auth issue.                                                                        |
| `--dangerously-skip-permissions cannot be used with root` | Service must run as non-root user (t3code), not root.                                                                                     |
| Claude uses API key instead of subscription               | Remove any `ANTHROPIC_API_KEY` from the environment. Don't use `EnvironmentFile`.                                                         |
| "Service not found: DockerWorkspace"                      | Docker layers not wired to provider adapters. Check `server.ts` provides `DockerWorkspaceLive` to adapter layers.                         |
| Codex shows "unauthenticated"                             | Auth is per-user. If you logged in as root, copy auth to t3code: `cp /root/.codex/auth.json /home/t3code/.codex/`                         |
| Pairing URL uses localhost                                | Access via `https://ai.texerman.com/pair#token=XXX` instead. Token is in the journal logs.                                                |
| Containers not spawning                                   | Verify `T3CODE_DOCKER_ENABLED=true` in service, check `docker images` has `homelab-agent-runtime`, verify t3code user is in docker group. |
