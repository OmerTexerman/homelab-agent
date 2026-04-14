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
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;

    if (isLogicalProjectWorkspaceRoot(input.cwd)) {
      yield* fileSystem
        .makeDirectory(serverConfig.stateDir, { recursive: true })
        .pipe(Effect.catch(() => Effect.void));
      return serverConfig.stateDir;
    }

    const cwdStat = yield* fileSystem
      .stat(input.cwd)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (cwdStat?.type === "Directory") {
      return input.cwd;
    }

    return yield* new TextGenerationError({
      operation: input.operation,
      detail: `Working directory does not exist: ${input.cwd}`,
    });
  },
);
