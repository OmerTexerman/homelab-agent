import { assert, it } from "@effect/vitest";
import { HomelabSkillName, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { HomelabSkills } from "../Services/HomelabSkills.ts";
import { HomelabSkillsLive } from "./HomelabSkills.ts";

const layer = it.layer(HomelabSkillsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const skillName = Schema.decodeUnknownSync(HomelabSkillName);

const scratchContext = (thread: string) =>
  ({ kind: "scratch", threadId: ThreadId.make(thread) }) as const;
const projectContext = (project: string) =>
  ({ kind: "project", projectId: ProjectId.make(project) }) as const;

layer("HomelabSkills", (it) => {
  it.effect("authors at the caller's scope and keeps scratch skills thread-private", () =>
    Effect.gen(function* () {
      const skills = yield* HomelabSkills;

      const created = yield* skills.upsert({
        context: scratchContext("thread-a"),
        name: skillName("proxmox-snapshot"),
        description: "Snapshot a Proxmox VM safely",
        body: "Use qm snapshot with a quiesced guest agent.",
      });
      assert.strictEqual(created.scope, "thread");
      assert.strictEqual(String(created.sourceThreadId), "thread-a");

      const ownView = yield* skills.listForContext(scratchContext("thread-a"));
      assert.deepStrictEqual(
        ownView.map((skill) => skill.name),
        ["proxmox-snapshot"],
      );

      const siblingView = yield* skills.listForContext(scratchContext("thread-b"));
      assert.deepStrictEqual(siblingView, []);

      const projectView = yield* skills.listForContext(projectContext("project-x"));
      assert.deepStrictEqual(projectView, []);
    }),
  );

  it.effect("rejects promoting a scratch skill to a project but allows global", () =>
    Effect.gen(function* () {
      const skills = yield* HomelabSkills;
      yield* skills.upsert({
        context: scratchContext("thread-promote"),
        name: skillName("dns-debug"),
        description: "Debug homelab DNS",
        body: "Check unbound logs first.",
      });

      const rejected = yield* skills
        .promote({
          context: scratchContext("thread-promote"),
          name: skillName("dns-debug"),
          to: "project",
        })
        .pipe(Effect.flip);
      assert.match(rejected.message, /no project to promote/i);

      const promoted = yield* skills.promote({
        context: scratchContext("thread-promote"),
        name: skillName("dns-debug"),
        to: "global",
      });
      assert.strictEqual(promoted.scope, "global");
      // Provenance survives global promotion.
      assert.strictEqual(String(promoted.sourceThreadId), "thread-promote");

      // Global skills are visible everywhere, scratch threads included.
      const otherScratch = yield* skills.listForContext(scratchContext("thread-other"));
      assert.deepStrictEqual(
        otherScratch.map((skill) => [skill.name, skill.scope]),
        [["dns-debug", "global"]],
      );
      const someProject = yield* skills.listForContext(projectContext("project-y"));
      assert.deepStrictEqual(
        someProject.map((skill) => skill.name),
        ["dns-debug"],
      );
    }),
  );

  it.effect("promotes project skills to global and shadows global by name at narrower scope", () =>
    Effect.gen(function* () {
      const skills = yield* HomelabSkills;
      const context = projectContext("project-shadow");

      yield* skills.upsert({
        context,
        name: skillName("deploy-checklist"),
        description: "Project deploy checklist",
        body: "project-specific steps",
      });
      const promoted = yield* skills.promote({
        context,
        name: skillName("deploy-checklist"),
        to: "global",
      });
      assert.strictEqual(promoted.scope, "global");

      // A new project-scoped skill with the same name shadows the global one in that project.
      yield* skills.upsert({
        context,
        name: skillName("deploy-checklist"),
        description: "Sharper project version",
        body: "overridden steps",
      });
      const view = yield* skills.listForContext(context);
      const entry = view.find((skill) => skill.name === "deploy-checklist");
      assert.strictEqual(entry?.scope, "project");
      assert.strictEqual(entry?.body, "overridden steps");
    }),
  );

  it.effect("adopts a scratch thread's skills into its new project on move/promote", () =>
    Effect.gen(function* () {
      const skills = yield* HomelabSkills;
      yield* skills.upsert({
        context: scratchContext("thread-adopt"),
        name: skillName("zfs-scrub"),
        description: "Scrub the pool",
        body: "zpool scrub tank",
      });

      const adopted = yield* skills.adoptThreadSkillsIntoProject({
        threadId: ThreadId.make("thread-adopt"),
        projectId: ProjectId.make("project-adopted"),
      });
      assert.deepStrictEqual(
        adopted.map((skill) => [skill.name, skill.scope]),
        [["zfs-scrub", "project"]],
      );

      // The shared test layer accumulates global skills from earlier cases; assert on the
      // project-scoped entry rather than the whole view.
      const projectView = yield* skills.listForContext(projectContext("project-adopted"));
      const adoptedEntry = projectView.find((skill) => skill.name === "zfs-scrub");
      assert.strictEqual(adoptedEntry?.scope, "project");
      const oldThreadView = yield* skills.listForContext(scratchContext("thread-adopt"));
      assert.strictEqual(
        oldThreadView.some((skill) => skill.scope === "thread"),
        false,
      );
    }),
  );
});
