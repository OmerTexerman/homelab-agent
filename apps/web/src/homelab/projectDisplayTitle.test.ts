import {
  createStandaloneProjectWorkspaceRoot,
  STANDALONE_PROJECT_ID,
  STANDALONE_PROJECT_TITLE,
} from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";

import { homelabProjectDisplayTitle, homelabWorkspaceRootLabel } from "./projectDisplayTitle";

describe("homelabWorkspaceRootLabel", () => {
  it("hides the internal logical-project root", () => {
    expect(homelabWorkspaceRootLabel(createLogicalProjectWorkspaceRoot("network"))).toBe(
      "Project Runtime",
    );
  });

  it("keeps a real filesystem root", () => {
    expect(homelabWorkspaceRootLabel("/home/me/infra")).toBe("/home/me/infra");
  });
});

describe("homelabProjectDisplayTitle", () => {
  it("calls the hidden scratch project Scratch", () => {
    expect(
      homelabProjectDisplayTitle({ id: STANDALONE_PROJECT_ID, title: STANDALONE_PROJECT_TITLE }),
    ).toBe("Scratch");
    expect(
      homelabProjectDisplayTitle(
        {
          id: "some-other-id",
          title: STANDALONE_PROJECT_TITLE,
          workspaceRoot: createStandaloneProjectWorkspaceRoot(),
        },
        "Grouped name",
      ),
    ).toBe("Scratch");
  });

  it("keeps other project titles, preferring the grouped display name", () => {
    expect(homelabProjectDisplayTitle({ id: "p1", title: "Network" })).toBe("Network");
    expect(homelabProjectDisplayTitle({ id: "p1", title: "Network" }, "Network (2)")).toBe(
      "Network (2)",
    );
  });
});
