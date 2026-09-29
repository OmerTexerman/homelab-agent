/**
 * `GET /api/thread-workspace/file?threadId=&path=` downloads one file from a
 * thread's runtime workspace, waking the runtime first.
 *
 * @module threadWorkspaceFileRoute
 */
import { AuthOrchestrationReadScope, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import { authenticateRawRouteWithScope, downloadContentDisposition } from "../http.ts";
import { OrchestrationCommandReadModel } from "../orchestration/Services/OrchestrationCommandReadModel.ts";
import { ThreadRuntime } from "../runtime/Services/ThreadRuntime.ts";
import { ThreadWorkspace } from "../runtime/Services/ThreadWorkspace.ts";
import { wakeThreadWorkspaceRuntime } from "../runtime/wakeThreadWorkspaceRuntime.ts";

export const THREAD_WORKSPACE_FILE_ROUTE_PATH = "/api/thread-workspace/file";

export const threadWorkspaceFileRouteLayer = HttpRouter.add(
  "GET",
  THREAD_WORKSPACE_FILE_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const threadIdParam = url.value.searchParams.get("threadId")?.trim() ?? "";
    const workspacePath = url.value.searchParams.get("path")?.trim() ?? "";
    if (!threadIdParam || !workspacePath) {
      return HttpServerResponse.text("Missing threadId or path parameter", { status: 400 });
    }

    const threadId = ThreadId.make(threadIdParam);
    const threadRuntime = yield* ThreadRuntime;
    const commandReadModel = yield* OrchestrationCommandReadModel;
    // Same create-if-missing wake as the WS workspace ops, so downloading from a
    // thread whose runtime was reaped (or never started) succeeds.
    yield* wakeThreadWorkspaceRuntime({
      threadId,
      threadRuntime,
      getReadModel: commandReadModel.getReadModel,
    });

    const threadWorkspace = yield* ThreadWorkspace;
    const downloadExit = yield* Effect.exit(
      threadWorkspace.downloadFile({ threadId, path: workspacePath }),
    );
    if (Exit.isFailure(downloadExit)) {
      const error = Cause.squash(downloadExit.cause);
      return HttpServerResponse.text(
        error instanceof Error ? error.message : "Unable to download workspace file.",
        { status: 400 },
      );
    }
    const downloadedFile = downloadExit.value;

    return HttpServerResponse.uint8Array(downloadedFile.bytes, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "Content-Disposition": downloadContentDisposition(downloadedFile.name),
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
