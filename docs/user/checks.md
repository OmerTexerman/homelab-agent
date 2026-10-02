# Scheduled checks

A check is an investigation an agent repeats on a schedule: "are the disks filling
up and did last night's backups run", "is every service answering", "are updates
waiting". Each check belongs to one project and runs in that project's runtime,
with the same tools, memory, and secrets as its other threads.

## Add a check

On the project's page, find **Checks** and select **New check**.

- **Start from** fills in one of three examples: **Disk & backups**, **Service
  health**, or **Updates available**. Edit them as you like.
- **Name** is what Home and notifications call the check.
- **What to check** is the prompt the agent gets every run. Say what to look at and
  what counts as needing attention.
- **Schedule** is one of:
  - **Every…** a number of minutes or hours (15 minutes at the shortest, one week at
    the longest);
  - **Daily** at a time;
  - **Weekly** on a day at a time.

  Times are in the server's time zone, shown under the schedule. You can change it
  in **Settings → Notifications**.

- **Notify** decides when you get a [notification](./notifications.md):
  - **When it needs attention** (the default): when a run reports attention or
    fails. You hear about it once, until you acknowledge it or a later run reports
    OK.
  - **After every run**.
  - **Never**: results show only on the project page and Home.

Checks run with the project's default model.

## What a run does

Each check has its own thread in the project, named **Check: _name_**. The first run
creates it, and every run after that is a new message in the same thread, so the
agent can compare with what it found last time. You can open the thread from the
check, or from the sidebar, to read the full investigation or ask a follow-up.

At the end of a run the agent reports one of:

- **OK**: nothing needs you.
- **Needs attention**: something does; the summary says what.
- **Failed**: the check couldn't be completed (a host was unreachable, a tool was
  missing).

A run that ends without a report counts as **Failed**, and so does one still going
after an hour (it is stopped).

## The Checks list

Each check shows its schedule, its last result with when it ran, when it runs
next, and the last summary. From the row you can:

- turn the schedule off and on with the switch (turning it back on doesn't run the
  checks you missed while it was off);
- **Run now** (▶), which starts a run right away;
- **Edit** the check;
- **Delete** the check and its run history. Its thread stays.

A check never runs twice at once. If a run is still going, or someone is using the
check's thread when a run is due, it waits.

## On Home

A check whose last run needed attention or failed shows under **Needs you** on
[Home](./home.md) and on the project's page. Selecting it opens the check's thread.
**Acknowledge** removes it until a later run needs attention again.

## When the server was down

If the server was off when runs were due, the check runs once when the server
comes back, not once for every run it missed.

## Which providers can run checks

The agent reports its result with a tool that Codex and Claude have in project
runtimes. With other providers, every run ends as **Failed** because the report
never arrives.
