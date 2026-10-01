# Projects

A project is a long-lived piece of your homelab work, such as "media server" or
"network". It owns a Project Runtime (the container its agents work in), its own
memory, the secrets scoped to it, and the tools its agents installed. Threads are
conversations inside a project.

## The project page

Every project has a page. Open it by selecting the project on [Home](./home.md),
with **Open project…** in the command palette, or with **Project settings** in the
command palette while a project's thread is open.

The page shows, from top to bottom:

- **The project's name and runtime state** (Running, Awake, Sleeping, Not started,
  Failed), with **New thread** and **Settings**. **Settings** opens
  **Settings → Projects** for this project.
- **The Project Runtime panel**, the same one a thread shows: queued work, rebuild
  notices, snapshots, and **Wake** or **Sleep**, **Reset**, **Cleanup**, and
  **Snapshot**. Reset and snapshots ask you to confirm first.
- **A start box.** Type what you want done and press `Enter` (or **Start**). The new
  thread opens in this project with your text sent as its first message. You can
  pick another project next to **in**.
- **Needs you**: approvals, questions, secret requests, and write approvals from
  this project's threads, plus runtime failures and waiting rebuilds.
- **Running**: this project's threads with an agent working right now.
- **Threads**: every thread in the project that isn't archived, newest first.
- **Memory**: the most recently updated entries in the project's memory. **All
  memory** opens **Settings → Memory & Knowledge** filtered to this project.
- **Secrets**: the secrets this project's runtime receives, both global ones and
  those limited to this project, with how each is delivered (**File** or
  **Brokered**). Values are never shown here. **Manage** opens **Settings → Secrets**.
- **Runtime tools**: packages agents recorded for this project's runtime, with what
  installing each one runs. They come back after every runtime rebuild. **Manage**
  opens **Settings → Project Runtime**, where you can remove them.
- **Egress activity**: recent requests from this project's runtimes that used a
  brokered secret. **All activity** opens **Settings → Secrets**. This section is
  hidden when your session can't read the egress log.

Needs you, Running, and Threads show eight rows each. Use **Show all** to see the
rest.

A link to a project that was removed, or that isn't on a connected machine, shows
**Project not found** with a way back Home.
