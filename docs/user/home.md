# Home

Home is the first page you see. It answers two questions: what needs you right
now, and what your agents are doing. Open it any time with **Home** at the bottom
of the sidebar, the app name at the top of the sidebar, or **Home** in the command
palette.

## Start a thread

The box at the top starts a new thread. Type what you want done, pick the project
next to **in**, and press `Enter` (or **Start**). The thread opens with your text in
its composer, so you can check the model and send. `Shift+Enter` adds a line.

The project defaults to the one you used most recently. **New scratch thread**
starts a one-off thread with its own runtime and no project.

## Needs you

Everything waiting on you, most urgent first:

1. Write approvals: an agent's request using a brokered secret, held until you
   decide (see [Secrets](./secrets.md#write-approvals)). Each shows the method, host
   and path, the secret, the thread that sent it, and the time left before it is
   denied, with **Approve once**, **Approve 15 min**, and **Deny** right in the row.
   The one running out of time first is on top.
2. Threads asking for approval.
3. Threads waiting for your answer to a question.
4. Secrets an agent requested. Selecting one opens **Settings → Secrets**, where you
   can provide or decline it.
5. Project Runtimes that failed.
6. Threads whose last turn failed. Settle the thread to clear it from this list.
7. Plans ready for your review.
8. Project Runtimes with a rebuild waiting. These rebuild on their own the next time
   the runtime is idle; the entry is for your information.

Selecting a thread entry opens that thread. Selecting a runtime entry opens the
project's latest thread, where the runtime panel shows details. A write approval
opens the thread that sent it (or **Settings → Secrets** when that thread isn't
known). The waiting thread can also show under **Running**.

While Home is still checking runtimes, write approvals, and secret requests, the
section says so instead of showing an empty list.

## Running

Threads with an agent working right now, including background work that continues
after a turn ends.

## Projects

Every project, most recently active first. Each row shows the project's runtime
state (Running, Awake, Sleeping, Not started, Failed), how many threads it has, how
many are running or waiting on you, queued work, and when it was last active.
Select a row to open the project's latest thread, or **+** to start a new thread in
it.

## Recent threads

Your other recent threads, newest first. Scratch threads show **Scratch** instead
of a project name.

Each section shows eight rows. Use **Show all** to see the rest.
