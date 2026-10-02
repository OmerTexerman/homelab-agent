# Notifications

Homelab Agent can send a push notification to your phone or desktop when an agent
needs you, through [ntfy](https://ntfy.sh). You don't need the app open.

## Set it up

1. Install the ntfy app (or use the web app) and subscribe to a topic. Pick a
   topic name nobody can guess: anyone who knows a public topic's name can read it.
   If you run your own ntfy server, you can use an access token instead.
2. Open **Settings → Notifications**.
3. Enter the **Topic URL**, for example `https://ntfy.sh/homelab-k7f3q9`.
4. If your topic needs one, enter the **Access token**. It is stored encrypted on
   the server and never shown again; the field just says it is saved. **Clear**
   removes it.
5. Check the **Link address**: the address you open Homelab Agent at. Tapping a
   notification opens the thread or page it is about there. It defaults to the
   address you're using now.
6. **Save**, then **Send test notification**. You should get it within seconds. If
   it doesn't arrive, the page shows what ntfy answered.

Changing notification settings needs the same permission as changing secrets.

## What you're notified about

Each can be turned off on its own:

| Event             | When                                                                                                                                               | Priority               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Approval requests | An agent asks to run a command or change a file.                                                                                                   | High                   |
| Questions         | An agent asks you something and waits for the answer.                                                                                              | High                   |
| Write approvals   | A request using a brokered secret is held for you.                                                                                                 | Urgent                 |
| Secret requests   | An agent asks for a secret that isn't set yet.                                                                                                     | High                   |
| Failed turns      | A thread's turn ends with an error.                                                                                                                | Default                |
| Scheduled checks  | A [check](./checks.md) needs attention or fails (or every run, if the check says so).                                                              | High (OK results: low) |
| Knowledge tidy    | A [scheduled knowledge tidy](./memory-and-knowledge.md#tidy-knowledge-automatically) finishes, with its summary. Uses the Scheduled checks switch. | Low (failed: high)     |

**Push notifications** at the top turns them all off without losing your settings.

## How often

You get one notification per thread and kind of event in ten minutes. If an agent
asks for three approvals in a row, you hear about the first one. Scheduled checks
notify once per problem: a check that keeps failing stays quiet until you
acknowledge it on Home or it reports OK again.

A notification that can't be delivered (ntfy is down, the network is out) is tried
a few more times and then dropped. Agents never wait for notifications.

## Set on the server

Whoever runs the server can set the topic, token, link address, and time zone with
environment variables instead. Those win over what you enter, and the page shows
them as set on the server.

## Time zone for scheduled checks

**Settings → Notifications** also holds the time zone daily and weekly checks run
in. It defaults to the server's own.
