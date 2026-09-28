// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { listDegradedStateFiles, loadJsonStateFile } from "./jsonStateFile.ts";

const State = Schema.Struct({ version: Schema.Literal(1), items: Schema.Array(Schema.String) });
const decode = Schema.decodeUnknownEffect(State);

const withTempDir = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "json-state-file-" });
    return yield* body(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("treats a missing file as fresh state and writes normally", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const filePath = NodePath.join(dir, "state.json");
      const stateFile = yield* loadJsonStateFile({ storeName: "Test store", filePath, decode });
      assert.isUndefined(stateFile.value);
      assert.isUndefined(stateFile.degraded);

      yield* stateFile.writeJson({ version: 1, items: ["a"] });
      const reloaded = yield* loadJsonStateFile({ storeName: "Test store", filePath, decode });
      assert.deepStrictEqual(reloaded.value, { version: 1, items: ["a"] });
    }),
  ),
);

it.effect("degrades on an empty file, moves it aside, and reports it", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const filePath = NodePath.join(dir, "state.json");
      NodeFS.writeFileSync(filePath, "  \n");

      const stateFile = yield* loadJsonStateFile({ storeName: "Test store", filePath, decode });
      assert.isUndefined(stateFile.value);
      assert.equal(stateFile.degraded?.reason, "empty file");
      const corruptPath = stateFile.degraded?.corruptPath;
      assert.isString(corruptPath);
      assert.equal(NodeFS.readFileSync(corruptPath!, "utf8"), "  \n");
      assert.isFalse(NodeFS.existsSync(filePath));

      const failure = yield* stateFile.writeJson({ version: 1, items: [] }).pipe(Effect.flip);
      assert.equal(failure._tag, "JsonStateFileDegradedError");
      assert.include(failure.message, `Test store is degraded: ${filePath}`);
      assert.include(failure.message, corruptPath!);
      assert.isFalse(NodeFS.existsSync(filePath));

      const degraded = yield* listDegradedStateFiles;
      assert.isTrue(degraded.some((entry) => entry.path === filePath));
    }),
  ),
);
