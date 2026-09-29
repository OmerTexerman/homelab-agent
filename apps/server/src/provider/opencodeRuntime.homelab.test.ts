// @effect-diagnostics nodeBuiltinImport:off
/**
 * Managed (Project Runtime) OpenCode server options on the upstream runtime:
 * reachable-URL selection before version verification, and the cleanup
 * command on scope close.
 */
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { expect } from "vite-plus/test";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const freePort = Effect.promise(
  () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    }),
);

// Listens on T3_TEST_PORT but announces a container-internal URL, like
// `opencode serve --hostname=0.0.0.0` inside a Project Runtime.
const FAKE_SERVER_SCRIPT = `import { createServer } from "node:http";
const server = createServer((request, response) => {
  if (request.url.startsWith("/global/health")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ healthy: true, version: "1.14.19" }));
    return;
  }
  response.end("ok");
});
server.listen(Number(process.env.T3_TEST_PORT), "127.0.0.1", () => {
  process.stdout.write("opencode server listening on http://172.17.0.2:4096\\n");
});
`;

it.live("uses the first reachable runtime URL and runs the cleanup command on close", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcessEnvironment;
    const executablePath = yield* HostProcessExecutablePath;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-managed-" });
    const scriptPath = path.join(tempDir, "opencode.mjs");
    const binaryPath = path.join(tempDir, "opencode");
    const cleanupPath = path.join(tempDir, "cleanup");
    const markerPath = path.join(tempDir, "cleaned");
    yield* fs.writeFileString(scriptPath, FAKE_SERVER_SCRIPT);
    yield* fs.writeFileString(
      binaryPath,
      '#!/bin/sh\nexec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"\n',
    );
    yield* fs.writeFileString(cleanupPath, `#!/bin/sh\necho "$@" > "${markerPath}"\n`);
    yield* fs.chmod(binaryPath, 0o755);
    yield* fs.chmod(cleanupPath, 0o755);

    const port = yield* freePort;
    const unreachablePort = yield* freePort;
    const runtime = yield* OpenCodeRuntime;
    const serverScope = yield* Scope.make();
    const server = yield* runtime
      .startOpenCodeServerProcess({
        binaryPath,
        directory: "/workspace/app",
        port: 4096,
        hostname: "0.0.0.0",
        cwd: tempDir,
        environment: {
          ...environment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: scriptPath,
          T3_TEST_PORT: String(port),
        },
        reachableUrls: [`http://127.0.0.1:${unreachablePort}`, `http://127.0.0.1:${port}`],
        cleanupCommand: { commandPath: cleanupPath, args: ["kill", "4096"] },
      })
      .pipe(Scope.provide(serverScope));

    expect(server.url).toBe(`http://127.0.0.1:${port}`);
    expect(server.version).toBe("1.14.19");

    yield* Scope.close(serverScope, Exit.void);
    expect((yield* fs.readFileString(markerPath)).trim()).toBe("kill 4096");
  }).pipe(
    Effect.scoped,
    Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
