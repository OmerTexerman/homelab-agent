import {
  createStandaloneProjectWorkspaceRoot,
  STANDALONE_PROJECT_ID,
  STANDALONE_PROJECT_TITLE,
} from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import { homelabProjectDisplayTitle } from "./projectDisplayTitle";

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
