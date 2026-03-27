import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";

import * as AcpClient from "./client";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

it.layer(NodeServices.layer)("effect-acp client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const command = ChildProcess.make("bun", ["run", yield* mockPeerPath], {
        cwd: path.join(import.meta.dirname, ".."),
        shell: process.platform === "win32",
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, prompts, receives updates, and handles permission requests", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const typedRequests = yield* Ref.make<Array<unknown>>([]);
      const typedNotifications = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();

      const client = yield* AcpClient.fromChildProcess(handle, {
        handlers: {
          requestPermission: () =>
            Effect.succeed({
              outcome: {
                outcome: "selected",
                optionId: "allow",
              },
            }),
          elicitation: () =>
            Effect.succeed({
              action: {
                action: "accept",
                content: {
                  approved: true,
                },
              },
            }),
          sessionUpdate: (notification) =>
            Ref.update(updates, (current) => [...current, notification]),
          elicitationComplete: (notification) =>
            Ref.update(elicitationCompletions, (current) => [...current, notification]),
          extRequests: {
            "x/typed_request": AcpClient.defineExtRequest(
              Schema.Struct({ message: Schema.String }),
              (payload) =>
                Ref.update(typedRequests, (current) => [...current, payload]).pipe(
                  Effect.as({
                    ok: true,
                    echoedMessage: payload.message,
                  }),
                ),
            ),
          },
          extNotifications: {
            "x/typed_notification": AcpClient.defineExtNotification(
              Schema.Struct({ count: Schema.Number }),
              (payload) => Ref.update(typedNotifications, (current) => [...current, payload]),
            ),
          },
        },
      });

      const init = yield* client.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: "effect-acp-test",
          version: "0.0.0",
        },
      });
      assert.equal(init.protocolVersion, 1);

      yield* client.authenticate({ methodId: "cursor_login" });

      const session = yield* client.createSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      assert.equal(session.sessionId, "mock-session-1");

      const prompt = yield* client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.equal(prompt.stopReason, "end_turn");

      const streamed = yield* Stream.runCollect(Stream.take(client.updates, 2));
      assert.equal(streamed.length, 2);
      assert.equal(streamed[0]?._tag, "SessionUpdate");
      assert.equal(streamed[1]?._tag, "ElicitationComplete");
      assert.equal((yield* Ref.get(updates)).length, 1);
      assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
      assert.deepEqual(yield* Ref.get(typedRequests), [{ message: "hello from typed request" }]);
      assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);

      const ext = yield* client.extRequest("x/echo", {
        hello: "world",
      });
      assert.deepEqual(ext, {
        echoedMethod: "x/echo",
        echoedParams: {
          hello: "world",
        },
      });
    }),
  );

  it.effect(
    "returns formatted invalid params when a typed extension request payload is wrong",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeHandle({ ACP_MOCK_BAD_TYPED_REQUEST: "1" });

        const client = yield* AcpClient.fromChildProcess(handle, {
          handlers: {
            requestPermission: () =>
              Effect.succeed({
                outcome: {
                  outcome: "selected",
                  optionId: "allow",
                },
              }),
            elicitation: () =>
              Effect.succeed({
                action: {
                  action: "accept",
                  content: {
                    approved: true,
                  },
                },
              }),
            extRequests: {
              "x/typed_request": AcpClient.defineExtRequest(
                Schema.Struct({ message: Schema.String }),
                () => Effect.succeed({ ok: true }),
              ),
            },
          },
        });

        yield* client.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });

        yield* client.authenticate({ methodId: "cursor_login" });

        const session = yield* client.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });

        const result = yield* Effect.exit(
          client.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hello" }],
          }),
        );

        if (result._tag !== "Failure") {
          assert.fail("Expected prompt to fail for invalid typed extension payload");
        }
        const rendered = Cause.pretty(result.cause);
        assert.include(rendered, "Invalid x/typed_request payload:");
        assert.include(rendered, "Expected string, got 123");
      }),
  );
});
