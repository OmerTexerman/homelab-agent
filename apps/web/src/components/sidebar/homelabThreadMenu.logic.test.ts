import { describe, expect, it } from "vite-plus/test";

import { sidebarThreadCreationRuntimeCopy } from "./homelabThreadMenu.logic";

describe("sidebarThreadCreationRuntimeCopy", () => {
  it("labels the default project runtime thread action as queued on the Project Runtime", () => {
    expect(sidebarThreadCreationRuntimeCopy("shared")).toMatchObject({
      label: "New thread",
      description: expect.stringContaining("Project Runtime"),
    });
  });

  it("labels isolated runtime thread creation as a runtime clone", () => {
    expect(sidebarThreadCreationRuntimeCopy("isolated")).toMatchObject({
      label: "New parallel thread",
      description: expect.stringContaining("Clones this Project Runtime"),
    });
  });
});
