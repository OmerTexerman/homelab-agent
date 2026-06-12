// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import { Effect, FileSystem } from "effect";

import { TextGenerationError } from "@t3tools/contracts";
import { isLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";

import { ServerConfig } from "../config.ts";

export const resolveProviderCliWorkingDirectory = Effect.fn("resolveProviderCliWorkingDirectory")(
  function* (input: {
    readonly cwd: string;
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    /**
     * Git-backed operations need the requested cwd and must fail when it is
     * missing; cwd-incidental operations (thread titles) can run anywhere and
     * prefer degrading to the state dir over failing.
     */
    readonly missingCwdBehavior?: "fail" | "fallback-to-state-dir";
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;

    const stateDirFallback = Effect.gen(function* () {
      yield* fileSystem
        .makeDirectory(serverConfig.stateDir, { recursive: true })
        .pipe(Effect.catch(() => Effect.void));
      return serverConfig.stateDir;
    });

    if (isLogicalProjectWorkspaceRoot(input.cwd)) {
      return yield* stateDirFallback;
    }

    const cwdStat = yield* fileSystem
      .stat(input.cwd)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (cwdStat?.type === "Directory") {
      return input.cwd;
    }

    if (input.missingCwdBehavior === "fallback-to-state-dir") {
      return yield* stateDirFallback;
    }

    return yield* new TextGenerationError({
      operation: input.operation,
      detail: `Working directory does not exist: ${input.cwd}`,
    });
  },
);
