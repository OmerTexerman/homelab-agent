# Homelab sign-in: sliding sessions, passkeys, quick pairing

Fork-owned additions to upstream's environment auth
([environment-auth.md](./environment-auth.md)). None of them change how
upstream issues or verifies sessions; they sit next to it.

## Sliding browser sessions

`apps/server/src/auth/homelabSessionRenewal.ts`, a global HTTP middleware
merged into `HomelabRoutesLive` (no change to `server.ts`).

- Runs only on `GET /api/auth/session` and `POST /api/auth/websocket-ticket`,
  the requests a browser makes on load and on every websocket (re)connect.
- When the request's session cookie verifies (`SessionStore.verify`), is a
  `browser-session-cookie` session, and more than half its TTL (`exp - iat`)
  has elapsed, it moves `auth_sessions.expires_at` forward one full TTL
  (`UPDATE ... WHERE revoked_at IS NULL`) and re-sets the cookie.
- The new token keeps the session id and every claim; only `iat` and `exp`
  change, and it is signed with the same `server-signing-key` secret. The
  renewal test verifies the new token with `SessionStore.verify`, so a change
  to upstream's signing scheme fails CI instead of logging users out.
- Revocation still works: every verify reads the row, and a revoked row is
  never extended. Bearer and DPoP sessions are not renewed.

## Passkeys (WebAuthn)

Server: `apps/server/src/auth/homelabPasskeys.ts` (service) and
`homelabPasskeyHttp.ts` (routes, merged into `HomelabRoutesLive`). Web:
`apps/web/src/homelab/passkeys.ts`, `components/auth/HomelabPasskeySignIn.tsx`
(one line in `PairingRouteSurface`), and
`components/settings/HomelabPasskeysSection.tsx` (one line in
`ConnectionsSettings`). Wire shapes: `packages/contracts/src/homelabPasskeys.ts`.
Libraries: `@simplewebauthn/server` and `@simplewebauthn/browser`.

| Route                                               | Auth           |
| --------------------------------------------------- | -------------- |
| `GET /api/homelab/passkeys/available`               | none           |
| `POST /api/homelab/passkeys/authentication/options` | none           |
| `POST /api/homelab/passkeys/authentication/verify`  | none           |
| `GET /api/homelab/passkeys`                         | `access:read`  |
| `POST /api/homelab/passkeys/registration/options`   | `access:write` |
| `POST /api/homelab/passkeys/registration/verify`    | `access:write` |
| `POST /api/homelab/passkeys/remove`                 | `access:write` |

- **Storage.** `auth_passkeys` in `homelab.sqlite`, migration 400, the auth
  range (400–499). See [homelab-storage.md](./homelab-storage.md#auth-400).
  The row keeps the scopes of the session that registered it.
- **Relying party.** Origin and RP ID come from the request the way
  `HttpServerRequest.toURL` builds it (Host plus `X-Forwarded-Proto`), with
  `X-Forwarded-Host` taking over the host when present. In dev the Vite proxy
  rewrites Host, so a request whose `Origin` equals `ServerConfig.devUrl` uses
  the dev origin. IP-address hosts are refused (WebAuthn can't bind to them),
  and `available` is answered per RP ID.
- **Ceremonies.** Discoverable credentials (`residentKey: "required"`,
  `userVerification: "preferred"`, `attestation: "none"`), so sign-in needs no
  username. Registration excludes credentials already registered for the RP ID.
  The client only offers passkeys when the page and the API share an origin,
  the context is secure, and the host is a domain or `localhost`. Hidden in
  Electron. No conditional-UI autofill yet.
- **Challenges.** In memory, single-use (removed on first use, success or not),
  five minutes, and bound to the origin and RP ID that started them;
  registration challenges are also bound to the registering session. At most
  64 are kept. A restart just means starting over.
- **Session.** A verified assertion updates the counter, `backed_up`, and
  `last_used_at`, then calls `SessionStore.issue` with
  `method: "browser-session-cookie"`, subject `passkey`, the stored scopes, and
  label `Passkey: <name>`, and sets the cookie with the same attributes as the
  pairing exchange (`auth/http.ts` `browserSession`). The session is an ordinary
  one: it renews, lists in Connections, and revokes there. Removing a passkey
  does not touch existing sessions.
- **Failures.** Ten failed sign-ins within a minute make sign-in answer 429
  until the window passes. Sign-ins, registrations, removals, and rejections
  are logged.
- **Dependency note.** `@simplewebauthn/server` breaks (`Cannot get schema for
'ECDSASigValue'`) if the lockfile holds two copies of
  `@peculiar/asn1-schema`. Keep one.

## Quick pairing

`apps/web/src/components/homelab/PairDeviceDialog.tsx`, opened from
`HomelabPairDeviceSidebarItem` (one line in `SidebarChrome`) and a command
palette entry in `useHomelabPaletteItems`, mounted next to the palette. It calls
the same `createServerPairingCredential` request Connections uses and links to
the current origin's `/pair`. Admin sessions on web only.

The host-side fallback is `deploy/proxmox/homelab-agent-pair.sh`, which runs
`auth pairing create --admin` inside the container (see
`deploy/proxmox/README.md`).
