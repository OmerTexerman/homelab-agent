# Exporting a chat

You can save the thread you are reading as a file. Open the command palette and
choose **Export chat as Markdown** or **Export chat as JSON**. These entries appear
only while a thread is open.

- **Markdown** is a readable transcript: the thread title, project, and dates,
  then each of your messages and the agent's replies in order. Each tool call is
  one line, such as `> ran: systemctl status nginx`. Command output is cut to its
  first few lines.
- **JSON** holds the thread's messages and activities as structured data, with
  full tool details, for scripts or archiving. The file has `schemaVersion: 1`.

The file is named after the thread title and today's date, for example
`fix-the-nas-2026-10-01.md`.

## Long threads

Long threads open with only their most recent turns. An export includes only what
is loaded. When older turns are missing, the file says so at the top (`"historyComplete":
false` in JSON) and the app warns you. To export everything, select **Load earlier
turns** at the top of the thread until nothing older is left, then export again.

## Secrets

Exports are not redacted. If an agent printed a password, token, or other secret in
the thread, that text is in the file. Check the file before you share it.
