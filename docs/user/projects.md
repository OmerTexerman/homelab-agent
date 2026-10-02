# Projects

A project is a long-lived piece of your homelab work, such as "media server" or
"network". It owns a Project Runtime (the container its agents work in), its own
memory, the secrets scoped to it, and the tools its agents installed. Threads are
conversations inside a project.

## Creating a project

**New project** (in the sidebar header or the command palette) asks for a name and,
optionally, **What does this project cover?**: the hosts and services it is about,
such as "Jellyfin, Sonarr, Radarr on the media VM 192.168.1.40; NAS at nas.lan".

With a description, **Have an agent survey it now** is on (you can turn it off, or
turn it on without a description). Creating the project then opens a thread named
**Survey: <project>** in which an agent, working from inside the project's runtime:

- checks what it can reach of what you described: addresses, ports, running
  services and their versions, and the configs and logs it can read,
- asks you when it lacks access (a password, an SSH key) instead of guessing, and
  requests credentials as [secrets](./secrets.md),
- changes nothing,
- records what it learns in the project's memory and the shared knowledge graph,
  so later threads start from it,
- ends with a short summary of what it found and what it couldn't reach.

The survey runs on the project's default model, like any new thread. It keeps
going if you close the browser. Without the survey, the project opens on an empty
thread as usual. The description is saved with the project either way.

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
- **Onboarding**, while the project has no memory and no checks: what you said the
  project covers, **Survey this project** (starts the survey described above, from
  that description), and **Add a check** (opens the check editor with the **Disk &
  backups** template filled in). It goes away once the project has memory or a check.
- **A start box.** Type what you want done and press `Enter` (or **Start**). The new
  thread opens in this project with your text sent as its first message. You can
  pick another project next to **in**.
- **Needs you**: approvals, questions, secret requests, and write approvals from
  this project's threads, plus runtime failures, waiting rebuilds, and checks that
  need attention.
- **Running**: this project's threads with an agent working right now.
- **Threads**: every thread in the project that isn't archived, newest first.
- **Checks**: the project's [scheduled checks](./checks.md), with each one's
  schedule, last result, and next run. **New check** adds one.
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
