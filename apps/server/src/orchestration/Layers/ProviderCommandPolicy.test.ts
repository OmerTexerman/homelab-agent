import { describe, expect, it } from "vitest";

import {
  buildGeneratedWorktreeBranchName,
  canReplaceThreadTitle,
  isTemporaryWorktreeBranch,
  mapProviderSessionStatusToOrchestrationStatus,
  toNonEmptyProviderInput,
} from "./ProviderCommandPolicy.ts";

describe("ProviderCommandPolicy", () => {
  it("normalizes provider text input", () => {
    expect(toNonEmptyProviderInput("  hello  ")).toBe("hello");
    expect(toNonEmptyProviderInput("   ")).toBeUndefined();
    expect(toNonEmptyProviderInput(undefined)).toBeUndefined();
  });

  it("maps provider session status into orchestration session status", () => {
    expect(mapProviderSessionStatusToOrchestrationStatus("connecting")).toBe("starting");
    expect(mapProviderSessionStatusToOrchestrationStatus("ready")).toBe("ready");
    expect(mapProviderSessionStatusToOrchestrationStatus("running")).toBe("running");
    expect(mapProviderSessionStatusToOrchestrationStatus("error")).toBe("error");
    expect(mapProviderSessionStatusToOrchestrationStatus("closed")).toBe("stopped");
  });

  it("allows title replacement only for default titles or the original seed", () => {
    expect(canReplaceThreadTitle("New thread")).toBe(true);
    expect(canReplaceThreadTitle(" Investigate NAS ", "Investigate NAS")).toBe(true);
    expect(canReplaceThreadTitle("Custom title", "Original seed")).toBe(false);
    expect(canReplaceThreadTitle("Custom title")).toBe(false);
  });

  it("detects temporary generated worktree branches", () => {
    expect(isTemporaryWorktreeBranch("t3code/12ab34ef")).toBe(true);
    expect(isTemporaryWorktreeBranch("T3CODE/12AB34EF")).toBe(true);
    expect(isTemporaryWorktreeBranch("t3code/feature")).toBe(false);
  });

  it("builds a stable generated branch name from model output", () => {
    expect(buildGeneratedWorktreeBranchName("refs/heads/T3CODE/Fix NAS's Certs!")).toBe(
      "t3code/fix-nass-certs",
    );
    expect(buildGeneratedWorktreeBranchName(" ??? ")).toBe("t3code/update");
  });
});
