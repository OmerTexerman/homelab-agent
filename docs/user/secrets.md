# Secrets

Agents ask for credentials with a secure prompt instead of in chat. When an agent
asks, a **Secret requested** prompt opens wherever you are in the app; enter the
value, **Decline**, or choose **Later** and answer it from **Settings → Secrets**
or from **Needs you** on Home. You can also limit a secret to specific projects.

## Delivery

Each secret has a **Delivery** setting. Choose it when you add a secret, or
change it later with **Delivery** on the secret's row (you don't need to enter
the value again).

- **File (agent sees the value)**: the default. Runtimes receive the real value.
- **Brokered (agent gets a stand-in; the server injects the real value only for
  allowed hosts)**: for HTTP API tokens. The agent only ever sees a placeholder
  that starts with `hlsur_`. When the agent calls one of the secret's allowed
  hosts over HTTP or HTTPS, Homelab Agent swaps the placeholder for the real
  token on the way out. Sent anywhere else, the request is refused.

Brokered secrets show a **Brokered** badge in the list, with the hosts they may
be sent to underneath.

With brokered delivery you also set:

- **Allowed hosts**: one per line. A hostname or IP address, optionally with a
  port, such as `pve.lan:8006` or `192.168.1.20`; `*.example.com` covers every
  subdomain of `example.com` (not `example.com` itself). No scheme or path.
  Mistakes are pointed out as you type, and at least one host is required.
- **Ask me before writes (POST/PUT/PATCH/DELETE)**: requests that change
  something wait for you to approve or deny them, up to five minutes. See
  [Write approvals](#write-approvals).
- **Skip TLS verification for these hosts (self-signed)**: for services with
  self-signed certificates.

Use brokered delivery for API tokens sent in headers or URLs. Keep SSH keys,
database passwords, and tokens that go in a request body on file delivery;
brokering them stops them working. Only allow hosts you trust not to echo
requests back, since a service that reflects headers would hand the real
token back to the agent.

## Write approvals

When a secret asks before writes, the agent's request is held until you decide.
You can't miss it:

- An **Approve this write?** prompt opens wherever you are in the app.
- It is first in **Needs you** on Home, with the method, host and path, the
  secret, the thread that sent it, and the time left.
- It shows under the runtime strip in the thread that sent it.

Each offers the same choices:

- **Approve once**: send this request.
- **Approve 15 min**: send it, and let that runtime write with that secret to
  that host without asking for 15 minutes.
- **Deny**: refuse it. The agent's request fails.

If nobody decides within five minutes, the request is denied. **Later** closes
the prompt and leaves the request on Home and in its thread. Restarting the
server denies any requests still waiting.

Answering needs the **Manage secrets** permission. A device paired without it
sees the requests but not the buttons, and doesn't get the prompt.

## Egress activity

**Settings → Secrets → Egress activity** lists the latest 100 requests that used
a brokered secret, newest first, with the time, secret, method, host and path,
the upstream response status, and what happened:

- **Substituted**: the real value was sent to an allowed host.
- **Approved**: the same, after you approved a write.
- **Blocked**: the placeholder was sent to a host the secret doesn't allow.
  These rows are highlighted: a blocked request can mean an agent was tricked
  into trying to send your token somewhere else.
- **Denied**: you denied a write, or nobody answered in time.

The list doesn't update on its own; use **Refresh**.
