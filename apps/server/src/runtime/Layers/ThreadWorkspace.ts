import nodeFs from "node:fs";
import nodePath from "node:path";

import {
  type ThreadWorkspaceEntriesResult,
  type ThreadWorkspaceEntry,
  type ThreadWorkspaceReadFileResult,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
} from "../../workspace/Services/WorkspacePaths.ts";
import {
  ThreadWorkspace,
  ThreadWorkspaceServiceError,
  type ThreadWorkspaceShape,
} from "../Services/ThreadWorkspace.ts";

const MAX_TEXT_FILE_BYTES = 1_024 * 1_024;

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function toThreadWorkspaceError(message: string, cause?: unknown): ThreadWorkspaceServiceError {
  return new ThreadWorkspaceServiceError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function encodeThreadSegment(threadId: string): string {
  return Buffer.from(threadId, "utf8").toString("base64url");
}

export const makeThreadWorkspace = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const workspacePaths = yield* WorkspacePaths;

  const resolveWorkspaceRoot = Effect.fn("threadWorkspace.resolveWorkspaceRoot")(function* (
    threadId: string,
  ) {
    const workspaceRoot = nodePath.join(
      stateDir,
      "thread-runtimes",
      encodeThreadSegment(threadId),
      "workspace",
    );

    yield* fileSystem
      .makeDirectory(workspaceRoot, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          toThreadWorkspaceError(
            `Failed to prepare the thread workspace for '${threadId}'.`,
            cause,
          ),
        ),
      );

    return workspaceRoot;
  });

  const resolvePathWithinWorkspace = Effect.fn("threadWorkspace.resolvePathWithinWorkspace")(
    function* (input: { threadId: string; relativePath: string }) {
      const workspaceRoot = yield* resolveWorkspaceRoot(input.threadId);
      return yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot,
          relativePath: input.relativePath,
        })
        .pipe(
          Effect.mapError((cause) =>
            Schema.is(WorkspacePathOutsideRootError)(cause)
              ? toThreadWorkspaceError("Workspace file path must stay within the thread workspace.")
              : toThreadWorkspaceError("Failed to resolve workspace path.", cause),
          ),
        );
    },
  );

  const listEntries: ThreadWorkspaceShape["listEntries"] = Effect.fn("threadWorkspace.listEntries")(
    function* (input) {
      const workspaceRoot = yield* resolveWorkspaceRoot(input.threadId);

      return yield* Effect.try({
        try: () => {
          const query = normalizeSearchQuery(input.query);
          const entries: ThreadWorkspaceEntry[] = [];
          let truncated = false;

          const visit = (absoluteDir: string, parentPath?: string): void => {
            const directoryEntries = nodeFs
              .readdirSync(absoluteDir, { withFileTypes: true })
              .toSorted((left, right) => {
                if (left.isDirectory() !== right.isDirectory()) {
                  return left.isDirectory() ? -1 : 1;
                }
                return left.name.localeCompare(right.name);
              });

            for (const directoryEntry of directoryEntries) {
              if (entries.length >= input.limit) {
                truncated = true;
                return;
              }

              const relativePath = parentPath
                ? `${parentPath}/${directoryEntry.name}`
                : directoryEntry.name;
              const absolutePath = nodePath.join(absoluteDir, directoryEntry.name);
              const isDirectory = directoryEntry.isDirectory();
              const candidate = relativePath.toLowerCase();
              const matches = query.length === 0 || candidate.includes(query);

              if (matches) {
                const stat = nodeFs.statSync(absolutePath);
                entries.push({
                  path: relativePath,
                  name: directoryEntry.name,
                  kind: isDirectory ? "directory" : "file",
                  ...(parentPath ? { parentPath } : {}),
                  ...(!isDirectory ? { sizeBytes: stat.size } : {}),
                });
              }

              if (isDirectory) {
                visit(absolutePath, relativePath);
                if (truncated) {
                  return;
                }
              }
            }
          };

          visit(workspaceRoot);

          return {
            entries,
            truncated,
          } satisfies ThreadWorkspaceEntriesResult;
        },
        catch: (cause) =>
          toThreadWorkspaceError(`Failed to list files for thread '${input.threadId}'.`, cause),
      });
    },
  );

  const readFile: ThreadWorkspaceShape["readFile"] = Effect.fn("threadWorkspace.readFile")(
    function* (input) {
      const target = yield* resolvePathWithinWorkspace({
        threadId: input.threadId,
        relativePath: input.path,
      });

      return yield* Effect.try({
        try: () => {
          const stat = nodeFs.statSync(target.absolutePath);
          if (!stat.isFile()) {
            throw new Error(`'${input.path}' is not a file.`);
          }

          if (stat.size > MAX_TEXT_FILE_BYTES) {
            return {
              path: target.relativePath,
              contents: null,
              sizeBytes: stat.size,
              isBinary: false,
              truncated: false,
              unsupportedReason: `Files larger than ${Math.floor(MAX_TEXT_FILE_BYTES / 1024)} KB cannot be edited here yet.`,
            } satisfies ThreadWorkspaceReadFileResult;
          }

          const buffer = nodeFs.readFileSync(target.absolutePath);
          if (isLikelyBinary(buffer)) {
            return {
              path: target.relativePath,
              contents: null,
              sizeBytes: buffer.length,
              isBinary: true,
              truncated: false,
              unsupportedReason: "Binary files cannot be edited in the browser editor yet.",
            } satisfies ThreadWorkspaceReadFileResult;
          }

          return {
            path: target.relativePath,
            contents: buffer.toString("utf8"),
            sizeBytes: buffer.length,
            isBinary: false,
            truncated: false,
            unsupportedReason: null,
          } satisfies ThreadWorkspaceReadFileResult;
        },
        catch: (cause) =>
          toThreadWorkspaceError(
            `Failed to read '${input.path}' from thread '${input.threadId}'.`,
            cause,
          ),
      });
    },
  );

  const writeFile: ThreadWorkspaceShape["writeFile"] = Effect.fn("threadWorkspace.writeFile")(
    function* (input) {
      const target = yield* resolvePathWithinWorkspace({
        threadId: input.threadId,
        relativePath: input.path,
      });

      yield* fileSystem
        .makeDirectory(nodePath.dirname(target.absolutePath), {
          recursive: true,
        })
        .pipe(
          Effect.mapError((cause) =>
            toThreadWorkspaceError(`Failed to create directories for '${input.path}'.`, cause),
          ),
        );

      yield* fileSystem
        .writeFileString(target.absolutePath, input.contents)
        .pipe(
          Effect.mapError((cause) =>
            toThreadWorkspaceError(
              `Failed to write '${input.path}' for thread '${input.threadId}'.`,
              cause,
            ),
          ),
        );

      return {
        path: target.relativePath,
      };
    },
  );

  const resolveEntryPath: ThreadWorkspaceShape["resolveEntryPath"] = Effect.fn(
    "threadWorkspace.resolveEntryPath",
  )(function* (input) {
    const target = yield* resolvePathWithinWorkspace({
      threadId: input.threadId,
      relativePath: input.path,
    });

    return yield* Effect.try({
      try: () => {
        const stat = nodeFs.statSync(target.absolutePath);
        if (stat.isDirectory()) {
          return {
            absolutePath: target.absolutePath,
            relativePath: target.relativePath,
            kind: "directory",
          } as const;
        }

        if (!stat.isFile()) {
          throw new Error(`'${input.path}' is not a regular file.`);
        }

        return {
          absolutePath: target.absolutePath,
          relativePath: target.relativePath,
          kind: "file",
        } as const;
      },
      catch: (cause) =>
        toThreadWorkspaceError(
          `Failed to resolve '${input.path}' from thread '${input.threadId}'.`,
          cause,
        ),
    });
  });

  return {
    listEntries,
    readFile,
    writeFile,
    resolveEntryPath,
  } satisfies ThreadWorkspaceShape;
});

export const ThreadWorkspaceLive = Layer.effect(ThreadWorkspace, makeThreadWorkspace);
