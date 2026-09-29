// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HomelabSkillId,
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type HomelabSkill,
  type OrchestrationThread,
  type ProjectMemoryEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { HomelabSecretRegistry } from "../homelab/Services/HomelabSecretRegistry.ts";
import {
  HOMELAB_VIEW_GENERATION_FILE,
  readHomelabViewGeneration,
  redactSecretValues,
  renderHomelabContextViewFiles,
  writeHomelabContextView,
} from "./HomelabContextView.ts";
import { writeHomelabSkillsView } from "./HomelabSkillsView.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-views");
const runtimeId = RuntimeSessionId.make("project-runtime:project-views");
const project = {
  id: projectId,
  title: "Views",
  workspaceRoot: "/workspace",
  defaultRuntimeId: runtimeId,
};

const thread = (id: string, text: string): OrchestrationThread => ({
  id: ThreadId.make(id),
  projectId,
  runtimeId,
  runtimeSelectionMode: "shared",
  title: `Thread ${id}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make(`message-${id}`),
      role: "user",
      text,
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  pullRequests: [],
  session: null,
});

const memory = (id: string): ProjectMemoryEntry => ({
  id: ProjectMemoryId.make(id),
  projectId,
  runtimeId,
  sourceThreadId: null,
  sourceMessageId: null,
  sourceFilePath: null,
  summary: `Memory ${id}`,
  body: `Body ${id}`,
  tags: [],
  supersedes: [],
  replaces: [],
  promotionStatus: "none",
  promotionId: null,
  promotionSummary: null,
  promotedAt: null,
  createdAt: now,
  updatedAt: now,
});

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "homelab-view-writers-" });
    return yield* use(dir);
  }).pipe(Effect.scoped);

const listFiles = (root: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      NodePath.relative(root, NodePath.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    )
    .toSorted();

it.effect("serializes concurrent view refreshes into complete views and bumps the generation", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const inputs = [
        { threads: [thread("a", "hello"), thread("b", "world")], memoryEntries: [memory("m1")] },
        { threads: [thread("c", "other")], memoryEntries: [memory("m2"), memory("m3")] },
      ];
      yield* Effect.forEach(
        inputs,
        (input) => writeHomelabContextView({ hostWorkspacePath: dir, project, ...input }),
        { concurrency: "unbounded", discard: true },
      );

      // Whichever refresh ran last, the view on disk is exactly that render: nothing from
      // the other one leaks through, nothing is missing, and no temp file is left behind.
      const onDisk = listFiles(NodePath.join(dir)).filter(
        (file) => file !== HOMELAB_VIEW_GENERATION_FILE,
      );
      const expected = inputs.map((input) =>
        renderHomelabContextViewFiles({ project, ...input })
          .map((file) => file.relativePath)
          .toSorted(),
      );
      assert.isTrue(
        expected.some((paths) => JSON.stringify(paths) === JSON.stringify(onDisk)),
        `view on disk is a mix of two renders: ${onDisk.join(", ")}`,
      );
      assert.equal(yield* readHomelabViewGeneration(dir), 2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replaces known secret values with $KEY placeholders in rendered views", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      yield* writeHomelabContextView({
        hostWorkspacePath: dir,
        project,
        threads: [thread("secret", "the token is s3cr3t-token-value, keep it safe")],
        memoryEntries: [],
      });
      for (const file of ["transcript.md", "messages.jsonl", "summary.md"]) {
        const contents = NodeFS.readFileSync(
          NodePath.join(dir, ".homelab/threads/thread_secret", file),
          "utf8",
        );
        assert.notInclude(contents, "s3cr3t-token-value");
        assert.include(contents, "$API_TOKEN");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(HomelabSecretRegistry)({
          materializeSecrets: () =>
            Effect.succeed([
              {
                key: "API_TOKEN",
                value: "s3cr3t-token-value",
                valueUpdatedAt: "2026-09-01T00:00:00.000Z",
              },
              { key: "SHORT", value: "abc", valueUpdatedAt: "2026-09-01T00:00:00.000Z" },
            ]),
          changes: Stream.empty,
        }),
      ),
    ),
  ),
);

it("redacts longest values first and leaves short values alone", () => {
  assert.equal(
    redactSecretValues("pw=hunter2-long and hunter2-long-suffix and abc", {
      A: "hunter2-long",
      B: "hunter2-long-suffix",
      C: "abc",
    }),
    "pw=$A and $B and abc",
  );
});

it.effect("materializes skills for Claude Code and for Codex/OpenCode", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const skill = (name: string): HomelabSkill => ({
        id: HomelabSkillId.make(`skill:${name}`),
        name: name as HomelabSkill["name"],
        scope: "global",
        projectId: null,
        sourceThreadId: null,
        description: `Use ${name}`,
        body: `# ${name}\n`,
        createdAt: now,
        updatedAt: now,
      });
      const workspaceRoot = NodePath.join(dir, "workspace");
      const homeRoot = NodePath.join(dir, "home");
      yield* writeHomelabSkillsView({
        workspaceRoot,
        homeRoot,
        skills: [skill("restart-stack"), skill("rotate-certs")],
      });
      for (const root of [".claude/skills", ".agents/skills"]) {
        for (const name of ["restart-stack", "rotate-certs"]) {
          assert.include(
            NodeFS.readFileSync(NodePath.join(homeRoot, root, name, "SKILL.md"), "utf8"),
            `name: ${name}`,
          );
        }
      }

      // A removed skill is pruned from both, and skills authored elsewhere are kept.
      NodeFS.mkdirSync(NodePath.join(homeRoot, ".agents/skills/hand-written"), { recursive: true });
      yield* writeHomelabSkillsView({ workspaceRoot, homeRoot, skills: [skill("restart-stack")] });
      for (const root of [".claude/skills", ".agents/skills"]) {
        assert.isFalse(NodeFS.existsSync(NodePath.join(homeRoot, root, "rotate-certs")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(homeRoot, root, "restart-stack")));
      }
      assert.isTrue(NodeFS.existsSync(NodePath.join(homeRoot, ".agents/skills/hand-written")));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
