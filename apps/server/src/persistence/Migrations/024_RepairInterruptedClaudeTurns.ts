import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Earlier builds could leave the latest user message unbound when a provider
  // turn had already started, which made the thread look like it still had a
  // "pending user turn" forever after reload.
  yield* sql`
    UPDATE projection_thread_messages
    SET
      turn_id = (
        SELECT projection_turns.turn_id
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_thread_messages.thread_id
          AND projection_turns.pending_message_id = projection_thread_messages.message_id
          AND projection_turns.turn_id IS NOT NULL
        ORDER BY projection_turns.requested_at DESC, projection_turns.turn_id DESC
        LIMIT 1
      ),
      updated_at = COALESCE(
        (
          SELECT projection_turns.started_at
          FROM projection_turns
          WHERE projection_turns.thread_id = projection_thread_messages.thread_id
            AND projection_turns.pending_message_id = projection_thread_messages.message_id
            AND projection_turns.turn_id IS NOT NULL
          ORDER BY projection_turns.requested_at DESC, projection_turns.turn_id DESC
          LIMIT 1
        ),
        updated_at
      )
    WHERE role = 'user'
      AND turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns
        WHERE projection_turns.thread_id = projection_thread_messages.thread_id
          AND projection_turns.pending_message_id = projection_thread_messages.message_id
          AND projection_turns.turn_id IS NOT NULL
      )
  `;

  // If a provider session is already idle again, any lingering "running" turn
  // row is stale and should be treated as interrupted instead of blocking the
  // thread forever.
  yield* sql`
    UPDATE projection_turns
    SET
      state = 'interrupted',
      completed_at = COALESCE(
        completed_at,
        (
          SELECT projection_thread_sessions.updated_at
          FROM projection_thread_sessions
          WHERE projection_thread_sessions.thread_id = projection_turns.thread_id
          LIMIT 1
        ),
        started_at,
        requested_at
      )
    WHERE state = 'running'
      AND turn_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM projection_thread_sessions
        WHERE projection_thread_sessions.thread_id = projection_turns.thread_id
          AND (
            projection_thread_sessions.status <> 'running'
            OR projection_thread_sessions.active_turn_id IS NULL
            OR projection_thread_sessions.active_turn_id <> projection_turns.turn_id
          )
      )
  `;
});
