import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import {
  homelabThreadMenuItems,
  sidebarThreadCreationRuntimeCopy,
} from "./homelabThreadMenu.logic";

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

describe("homelabThreadMenuItems", () => {
  const upstreamItems = [
    { id: "pin", label: "Pin" },
    { id: "rename", label: "Rename thread", separatorBefore: true },
    {
      id: "copy",
      label: "Copy",
      children: [
        { id: "copy-path", label: "Path" },
        { id: "copy-thread-id", label: "Thread ID" },
      ],
    },
    { id: "project-settings", label: "Project settings" },
    { id: "delete", label: "Delete", destructive: true },
  ];

  it("inserts move/promote before rename only for scratch threads", () => {
    const scratch = homelabThreadMenuItems(upstreamItems, { projectId: STANDALONE_PROJECT_ID });
    expect(scratch.map((item) => item.id)).toEqual([
      "pin",
      "move-to-project",
      "promote-to-project",
      "rename",
      "copy",
      "delete",
    ]);

    const regular = homelabThreadMenuItems(upstreamItems, { projectId: "project-1" });
    expect(regular.map((item) => item.id)).toEqual([
      "pin",
      "rename",
      "copy",
      "project-settings",
      "delete",
    ]);
  });

  it("drops the host path copy entry while host-path UI is hidden", () => {
    const copy = homelabThreadMenuItems(upstreamItems, { projectId: "project-1" }).find(
      (item) => item.id === "copy",
    );
    expect(copy?.children?.map((item) => item.id)).toEqual(["copy-thread-id"]);
  });
});
