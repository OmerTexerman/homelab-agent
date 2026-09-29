import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { rejectLogicalWorkspaceRoot } from "./logicalWorkspaceRoot.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const LOGICAL_ROOT = "homelab://project/project-alpha";

const EntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(EntriesLayer),
    ),
  ),
  Layer.provideMerge(EntriesLayer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-logical-workspace-root-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer, { excludeTestServices: true })("logical workspace roots", (it) => {
  describe("rejectLogicalWorkspaceRoot", () => {
    it.effect("rejects logical project workspace roots with the canonical root", () =>
      Effect.gen(function* () {
        const error = yield* rejectLogicalWorkspaceRoot(` ${LOGICAL_ROOT} `).pipe(Effect.flip);

        expect(error._tag).toBe("LogicalWorkspaceRootError");
        expect(error.workspaceRoot).toBe(LOGICAL_ROOT);
        expect(error.message).toContain("Logical project roots are not filesystem paths:");
      }),
    );

    it.effect("accepts host paths", () => rejectLogicalWorkspaceRoot(process.cwd()));
  });

  it.effect("WorkspaceEntries.search fails with LogicalWorkspaceRootError", () =>
    Effect.gen(function* () {
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

      const error = yield* workspaceEntries
        .search({ cwd: LOGICAL_ROOT, query: "readme", limit: 10 })
        .pipe(Effect.flip);

      expect(error._tag).toBe("LogicalWorkspaceRootError");
    }),
  );

  it.effect("WorkspaceFileSystem.writeFile fails before touching the host filesystem", () =>
    Effect.gen(function* () {
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

      const error = yield* workspaceFileSystem
        .writeFile({ cwd: LOGICAL_ROOT, relativePath: "notes.md", contents: "hi" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "WorkspaceFileSystemOperationError",
        operation: "resolve-filesystem-workspace-root",
      });
    }),
  );
});
