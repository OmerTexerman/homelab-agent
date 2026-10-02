# Memory and knowledge

Agents keep what they learn in two places: each project's **memory** (findings,
gotchas, how to reach things) and the shared **knowledge graph** (hosts, services,
and how they connect). Later threads search both instead of starting from scratch.
**Settings → Memory & Knowledge** shows all of it and is where you keep it tidy.

## Knowledge curator

**Start curator session** opens a curator session: an agent with read and write
access to the whole knowledge graph, every project's memory, and the skills
library. It runs in its own isolated runtime. Pick its model and effort next to
the button; the choice is remembered for the next session.

A session starts with a full inventory and then proposes corrections, merges,
rewrites, and removals, with reasons. It waits for your go-ahead before it
changes anything.

**Recent curator sessions** lists sessions you can go back to. Sessions are
deleted, with their runtimes, after 14 days without activity. You can delete one
sooner with its trash button.

The curator needs a device paired with permission to curate. Without it, this
section says so.

## Tidy knowledge automatically

**Tidy knowledge automatically** runs a curator session on a schedule, with
nobody watching:

- **Off** (the default), or **Weekly** on a day at a time. Times are in the
  server's time zone, shown under the schedule (change it in
  **Settings → Notifications**). Select **Save** after changing it.
- Each run is a new curator session titled **Scheduled knowledge tidy**. It
  makes the changes that are clearly safe (merging duplicates, fixing vague or
  misfiled entries, normalizing kinds, re-verifying stale facts it can check)
  and leaves judgment calls for you, listing them in its summary.
- It waits while any curator session, yours included, is in the middle of a
  turn, then tries again a few minutes later. A tidy that runs longer than three
  hours is stopped.
- When it finishes you get a [notification](./notifications.md) with its
  summary: low priority when it finished, high priority when it failed.
- Below the schedule: the last result, when it ran and runs next, its summary,
  **Run now**, and **Open last session**.

The tidy uses the model last picked for curator sessions. If none was ever
picked, it uses the best available provider.

Switching it off keeps its history; switching it back on counts the next run
from that moment, so it never runs for the weeks it was off.
