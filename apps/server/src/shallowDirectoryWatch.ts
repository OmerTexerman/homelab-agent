// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export function watchDirectoryShallow(
  directoryPath: string,
): Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError> {
  return Stream.callback<FileSystem.WatchEvent, PlatformError.PlatformError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = NodeFs.watch(
          directoryPath,
          { recursive: false },
          (_eventType, fileName) => {
            if (fileName === null) {
              return;
            }

            Queue.offerUnsafe(queue, {
              _tag: "Update",
              path: fileName.toString(),
            });
          },
        );

        watcher.on("error", (cause) => {
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(
              PlatformError.systemError({
                module: "FileSystem",
                method: "watch",
                _tag: "Unknown",
                pathOrDescriptor: directoryPath,
                cause,
              }),
            ),
          );
        });
        watcher.on("close", () => {
          Queue.endUnsafe(queue);
        });

        return watcher;
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    ),
  );
}
