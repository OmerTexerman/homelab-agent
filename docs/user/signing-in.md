# Signing in and adding devices

Homelab Agent keeps each browser signed in with a session. You start a session
by pairing (opening a one-time pairing link) or by signing in with a passkey.

## Sessions renew while you use them

A browser that keeps using Homelab Agent stays signed in. Each session lasts
30 days from its last renewal, and it renews itself when you open the app after
more than half of that time has passed. A browser you haven't opened for 30
days signs out and needs to pair or sign in with a passkey again.

Revoking a device in **Settings → Devices & Sessions** ends its session right
away, whether or not it renewed.

## Sign in with a passkey

A passkey lets you sign in with Face ID, Touch ID, Windows Hello, your phone,
or a security key instead of a pairing link.

To add one, open **Settings → Devices & Sessions** on a device that is already
signed in with full access, enter a name under **Passkeys**, and choose **Add
passkey**. Your browser or password manager saves it. A passkey signs you in
with the same access as the session that added it, so a passkey added from a
full-access session signs in with full access.

To sign in, open Homelab Agent on a device that isn't signed in. The pairing
screen shows **Sign in with passkey** once a passkey exists for this server.
Choose it and confirm with your device. No username is needed.

Passkeys only work when you open Homelab Agent by its domain name over HTTPS
(for example `https://ai.example.com`) or on `localhost`, not by an IP address.
A passkey belongs to the name you added it on: one added on
`https://ai.example.com` does not work on a different address for the same
server. The desktop app doesn't show passkeys.

Removing a passkey in **Settings → Devices & Sessions** stops it from signing
in. Devices already signed in with it stay signed in until you revoke them in
the same place.

## Pair a device

On a device signed in with full access, choose the QR code button in the
sidebar footer, or run **Pair a device** from the command palette. Scan the QR
code with the new device's camera, or copy the link to it. The link works once
and expires after a few minutes. Check **Full access** first if the new device
should also manage devices, passkeys, and secrets.

The link also appears under **Settings → Devices & Sessions**, where you can
revoke it before it is used.

## If no device is signed in

Whoever runs the server can create a pairing link from the server's command
line with `t3 auth pairing create --admin --base-url <your server URL>`. On the
reference Proxmox deployment, `homelab-agent-pair` on the host prints the link
and a QR code.
