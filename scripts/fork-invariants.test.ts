import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { parse } from "yaml";

// Homelab fork invariants for CI. Blacksmith runners never pick up jobs in the
// fork, so any Blacksmith `runs-on` in ci.yml leaves the job queued until it
// times out (~48h). Upstream syncs keep reintroducing them.
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const allowedRunner = /^(ubuntu|macos|windows)-[\w.-]+$/;

interface CiWorkflow {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, { readonly "runs-on"?: unknown }>;
}

const readCiWorkflow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workflow: CiWorkflow = parse(yield* fs.readFileString(ciWorkflowUrl.pathname));
  return workflow;
});

describe("fork CI workflow", () => {
  it.effect("runs every job on a GitHub-hosted runner", () =>
    Effect.gen(function* () {
      const jobs = Object.entries((yield* readCiWorkflow).jobs);
      assert.isAbove(jobs.length, 0);
      for (const [name, job] of jobs) {
        const runner = job["runs-on"];
        assert.isString(runner, `job ${name}`);
        assert.match(String(runner), allowedRunner, `job ${name}`);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("can be dispatched manually", () =>
    Effect.gen(function* () {
      assert.include(Object.keys((yield* readCiWorkflow).on), "workflow_dispatch");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
