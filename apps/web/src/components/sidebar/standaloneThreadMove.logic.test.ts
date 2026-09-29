import { ProjectMemoryId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStandaloneThreadMoveMemoryMigration,
  runWithSubmittingState,
  standaloneThreadMoveMemoryDescription,
  standaloneThreadMoveRuntimeDescription,
} from "./standaloneThreadMove.logic";

describe("runWithSubmittingState", () => {
  it("clears the submitting flag when the task reports a failure", async () => {
    const states: boolean[] = [];
    const result = await runWithSubmittingState(
      (submitting) => states.push(submitting),
      async () => ({ _tag: "Failure" as const }),
    );
    expect(result).toEqual({ _tag: "Failure" });
    expect(states).toEqual([true, false]);
  });

  it("clears the submitting flag when the task throws", async () => {
    const states: boolean[] = [];
    await expect(
      runWithSubmittingState(
        (submitting) => states.push(submitting),
        async () => {
          throw new Error("move failed");
        },
      ),
    ).rejects.toThrow("move failed");
    expect(states).toEqual([true, false]);
  });
});

describe("standalone thread move helpers", () => {
  it("builds explicit no-memory migration options", () => {
    expect(
      buildStandaloneThreadMoveMemoryMigration({
        mode: "none",
        selection: "selected",
        selectedMemoryIds: [ProjectMemoryId.make("memory-router")],
      }),
    ).toEqual({ mode: "none" });
  });

  it("builds all-relevant copy options without selected ids", () => {
    expect(
      buildStandaloneThreadMoveMemoryMigration({
        mode: "copy",
        selection: "all-relevant",
        selectedMemoryIds: [ProjectMemoryId.make("memory-router")],
      }),
    ).toEqual({ mode: "copy" });
  });

  it("builds selected move options with selected ids", () => {
    expect(
      buildStandaloneThreadMoveMemoryMigration({
        mode: "move",
        selection: "selected",
        selectedMemoryIds: [
          ProjectMemoryId.make("memory-router"),
          ProjectMemoryId.make("memory-dashboard"),
        ],
      }),
    ).toEqual({
      mode: "move",
      memoryIds: ["memory-router", "memory-dashboard"],
    });
  });

  it("keeps move dialog copy explicit about transcript, memory, and runtime filesystem state", () => {
    expect(standaloneThreadMoveMemoryDescription("none", "all-relevant")).toContain(
      "Chat transcript moves automatically",
    );
    expect(standaloneThreadMoveMemoryDescription("copy", "selected")).toContain(
      "selected Scratch memory entries are copied",
    );
    expect(standaloneThreadMoveRuntimeDescription()).toContain(
      "joins the project as a shared thread",
    );
    expect(standaloneThreadMoveRuntimeDescription()).toContain("becomes the project's default");
  });
});
