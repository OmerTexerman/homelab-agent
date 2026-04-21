import { describe, expect, it } from "vitest";

import {
  isClaudeUserInterruptionDiagnostic,
  isProviderInterruptionMessage,
} from "./providerInterruptions";

describe("providerInterruptions", () => {
  it("detects Claude ede interruption diagnostics", () => {
    expect(
      isClaudeUserInterruptionDiagnostic(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
    ).toBe(true);
    expect(
      isProviderInterruptionMessage(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
      ),
    ).toBe(true);
  });

  it("detects generic interruption messages", () => {
    expect(isProviderInterruptionMessage("Error: Request was aborted.")).toBe(true);
    expect(isProviderInterruptionMessage("All fibers interrupted without error")).toBe(true);
    expect(isProviderInterruptionMessage("Interrupted by user")).toBe(true);
  });

  it("does not match ordinary failures", () => {
    expect(isProviderInterruptionMessage("Claude Code process exited with code 137")).toBe(false);
    expect(isProviderInterruptionMessage("Turn failed")).toBe(false);
  });
});
