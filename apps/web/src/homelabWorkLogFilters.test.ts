import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withoutProviderInterruptionActivities } from "./homelabWorkLogFilters";
import { deriveWorkLogEntries } from "./session-logic";

function runtimeError(id: string, createdAt: string, message: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt,
    kind: "runtime.error",
    summary: "Runtime error",
    tone: "error",
    payload: { message },
    turnId: null,
  };
}

describe("withoutProviderInterruptionActivities", () => {
  it("omits interrupted runtime diagnostics from the work log", () => {
    const activities = [
      runtimeError(
        "runtime-interrupted",
        "2026-02-23T00:00:01.000Z",
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
      runtimeError(
        "runtime-real",
        "2026-02-23T00:00:02.000Z",
        "Claude Code process exited with code 137",
      ),
    ];

    const entries = deriveWorkLogEntries(withoutProviderInterruptionActivities(activities));
    expect(entries.map((entry) => entry.id)).toEqual(["runtime-real"]);
  });

  it("returns the same array when nothing is filtered", () => {
    const activities = [
      runtimeError("runtime-real", "2026-02-23T00:00:02.000Z", "process exited with code 137"),
    ];

    expect(withoutProviderInterruptionActivities(activities)).toBe(activities);
  });
});
