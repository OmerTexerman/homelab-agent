import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import { makeAcpSessionRuntime, type AcpSessionRequestLogEvent } from "./AcpSessionRuntime.ts";
import type * as EffectAcpProtocol from "effect-acp/protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";

describe("AcpSessionRuntime", () => {
  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* makeAcpSessionRuntime({
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
        authMethodId: "test",
      });

      expect(runtime.initializeResult).toMatchObject({ protocolVersion: 1 });
      expect(runtime.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.events, 2)));
      expect(notes).toHaveLength(2);
      expect(notes.map((note) => note._tag)).toEqual(["PlanUpdated", "ContentDelta"]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload.plan).toHaveLength(2);
      }

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("logs ACP requests from the shared runtime", () =>
    Effect.gen(function* () {
      const requestEvents: Array<AcpSessionRequestLogEvent> = [];
      const runtime = yield* makeAcpSessionRuntime({
        authMethodId: "test",
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
        requestLogger: (event) =>
          Effect.sync(() => {
            requestEvents.push(event);
          }),
      });

      yield* runtime.setModel("composer-2");
      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "succeeded",
        ),
      ).toBe(true);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("emits low-level ACP protocol logs for raw and decoded messages", () =>
    Effect.gen(function* () {
      const protocolEvents: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
      const runtime = yield* makeAcpSessionRuntime({
        authMethodId: "test",
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
        protocolLogging: {
          logIncoming: true,
          logOutgoing: true,
          logger: (event) =>
            Effect.sync(() => {
              protocolEvents.push(event);
            }),
        },
      });

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "decoded"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "decoded"),
      ).toBe(true);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects invalid config option values before sending session/set_config_option", () =>
    Effect.gen(function* () {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "acp-runtime-"));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const runtime = yield* makeAcpSessionRuntime({
        authMethodId: "test",
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
          env: {
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          },
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
      });

      const error = yield* runtime.setModel("composer-2[fast=false]").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          'Invalid value "composer-2[fast=false]" for session config option "model"',
        );
        expect(error.message).toContain("composer-2[fast=true]");
      }

      yield* runtime.close;

      const recordedRequests = readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } });
      expect(
        recordedRequests.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "composer-2[fast=false]",
        ),
      ).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
