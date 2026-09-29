import { ThreadId } from "@t3tools/contracts";
import { CURATOR_PROJECT_ID } from "@t3tools/shared/curatorProject";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import { threadLocalMemoryThreadId } from "./memoryScope";

const threadId = ThreadId.make("thread-1");

describe("threadLocalMemoryThreadId", () => {
  it("narrows scratch and curator threads to their own memory", () => {
    expect(threadLocalMemoryThreadId(STANDALONE_PROJECT_ID, threadId)).toBe(threadId);
    expect(threadLocalMemoryThreadId(CURATOR_PROJECT_ID, threadId)).toBe(threadId);
  });

  it("reads project memory for project threads", () => {
    expect(threadLocalMemoryThreadId("network", threadId)).toBeNull();
  });

  it("has nothing to narrow without a thread", () => {
    expect(threadLocalMemoryThreadId(STANDALONE_PROJECT_ID, null)).toBeNull();
  });
});
