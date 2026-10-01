# Secrets

Agents ask for credentials with a secure prompt instead of in chat. You provide
or decline them in **Settings → Secrets**, and you can limit a secret to
specific projects.

## Brokered secrets

By default a runtime receives a secret's real value. For an HTTP API token you
can choose **brokered** delivery instead. The agent then only ever sees a
placeholder that starts with `hlsur_`. When the agent calls one of the
secret's **allowed hosts** over HTTP or HTTPS, Homelab Agent swaps the
placeholder for the real token on the way out. Sent anywhere else, the request
is refused.

- **Allowed hosts**: hostnames or IP addresses, optionally with a port, such as
  `pve.lan:8006`, `192.168.1.20`, or `*.example.com` for every subdomain.
- **Approve writes**: requests that change something (anything but reads) wait
  for you to approve or deny them, up to five minutes. You can approve one
  request, or approve that secret on that host for 15 minutes.
- **Skip TLS verification**: for services with self-signed certificates.

Every request that used a brokered secret is recorded: allowed, approved,
blocked, or denied.

Use brokered delivery for API tokens sent in headers or URLs. Keep SSH keys,
database passwords, and tokens that go in a request body on normal delivery;
brokering them stops them working. Only allow hosts you trust not to echo
requests back, since a service that reflects headers would hand the real
token back to the agent.
