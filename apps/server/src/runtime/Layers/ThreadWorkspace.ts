import { Buffer } from "node:buffer";
import nodePath from "node:path";

import {
  ThreadWorkspaceEntriesResult as ThreadWorkspaceEntriesResultSchema,
  ThreadWorkspaceReadFileResult as ThreadWorkspaceReadFileResultSchema,
  type ThreadWorkspaceReadFileResult,
  ThreadWorkspaceWriteFileResult as ThreadWorkspaceWriteFileResultSchema,
  type ThreadId,
} from "@t3tools/contracts";
import { parseLogicalProjectWorkspacePath } from "@t3tools/shared/workspace";
import { Effect, Layer, Schema } from "effect";

import { runProcess, type ProcessRunOptions } from "../../processRunner.ts";
import {
  ThreadRuntime,
  type ThreadExecutionContext,
  type ThreadRuntimeLaunchContext,
} from "../Services/ThreadRuntime.ts";
import {
  ThreadWorkspace,
  ThreadWorkspaceServiceError,
  type ThreadWorkspaceDownloadFileResult,
  type ThreadWorkspaceShape,
} from "../Services/ThreadWorkspace.ts";

const MAX_TEXT_FILE_BYTES = 1_024 * 1_024;
const MAX_DOWNLOAD_FILE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_PROCESS_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_BUFFER_BYTES = 12 * 1_024 * 1_024;
const DEFAULT_CONTAINER_WORKSPACE_PATH = "/workspace";
const DEFAULT_CONTAINER_HOME_PATH = "/runtime/home";

const ThreadWorkspaceDownloadPayloadSchema = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  contentsBase64: Schema.String,
});

const LIST_THREAD_WORKSPACE_SCRIPT = [
  "python3 - <<'PY'",
  "import json",
  "import os",
  "",
  "base_path = os.environ.get('T3_THREAD_WORKSPACE_BASE_PATH', '/workspace')",
  "query = os.environ.get('T3_THREAD_WORKSPACE_QUERY', '').strip().lower()",
  "limit = int(os.environ.get('T3_THREAD_WORKSPACE_LIMIT', '1000'))",
  "",
  "if not os.path.exists(base_path):",
  "    raise SystemExit(f'Path does not exist: {base_path}')",
  "if not os.path.isdir(base_path):",
  "    raise SystemExit(f'Path is not a directory: {base_path}')",
  "",
  "entries = []",
  "truncated = False",
  "children = []",
  "with os.scandir(base_path) as scan_entries:",
  "    for child in scan_entries:",
  "        try:",
  "            is_directory = child.is_dir()",
  "            stat = child.stat()",
  "        except OSError:",
  "            continue",
  "        children.append((0 if is_directory else 1, child.name.casefold(), child.name, is_directory, stat.st_size if not is_directory else None, child.path))",
  "",
  "for _, _, child_name, is_directory, size_bytes, child_path in sorted(children):",
  "    candidate = f'{child_name} {child_path}'.lower()",
  "    if query and query not in candidate:",
  "        continue",
  "    if len(entries) >= limit:",
  "        truncated = True",
  "        break",
  "    entry = {",
  "        'path': os.path.normpath(child_path),",
  "        'name': child_name,",
  "        'kind': 'directory' if is_directory else 'file',",
  "    }",
  "    if size_bytes is not None:",
  "        entry['sizeBytes'] = size_bytes",
  "    entries.append(entry)",
  "",
  "print(json.dumps({",
  "    'basePath': os.path.normpath(base_path),",
  "    'entries': entries,",
  "    'truncated': truncated,",
  "}))",
  "PY",
].join("\n");

const READ_THREAD_WORKSPACE_FILE_SCRIPT = [
  "python3 - <<'PY'",
  "import json",
  "import os",
  "",
  "target_path = os.environ['T3_THREAD_WORKSPACE_TARGET_PATH']",
  "max_bytes = int(os.environ.get('T3_THREAD_WORKSPACE_TEXT_LIMIT', '1048576'))",
  "",
  "if not os.path.exists(target_path):",
  "    raise SystemExit(f'Path does not exist: {target_path}')",
  "if not os.path.isfile(target_path):",
  "    raise SystemExit(f\"'{target_path}' is not a file.\")",
  "",
  "size_bytes = os.path.getsize(target_path)",
  "normalized_path = os.path.normpath(target_path)",
  "if size_bytes > max_bytes:",
  "    print(json.dumps({",
  "        'path': normalized_path,",
  "        'contents': None,",
  "        'sizeBytes': size_bytes,",
  "        'isBinary': False,",
  "        'truncated': False,",
  "        'unsupportedReason': f'Files larger than {max_bytes // 1024} KB cannot be edited here yet.',",
  "    }))",
  "    raise SystemExit(0)",
  "",
  "with open(target_path, 'rb') as file_handle:",
  "    data = file_handle.read()",
  "",
  "if b'\\x00' in data:",
  "    print(json.dumps({",
  "        'path': normalized_path,",
  "        'contents': None,",
  "        'sizeBytes': len(data),",
  "        'isBinary': True,",
  "        'truncated': False,",
  "        'unsupportedReason': 'Binary files cannot be edited in the browser editor yet.',",
  "    }))",
  "    raise SystemExit(0)",
  "",
  "try:",
  "    contents = data.decode('utf-8')",
  "except UnicodeDecodeError:",
  "    print(json.dumps({",
  "        'path': normalized_path,",
  "        'contents': None,",
  "        'sizeBytes': len(data),",
  "        'isBinary': True,",
  "        'truncated': False,",
  "        'unsupportedReason': 'Binary files cannot be edited in the browser editor yet.',",
  "    }))",
  "    raise SystemExit(0)",
  "",
  "print(json.dumps({",
  "    'path': normalized_path,",
  "    'contents': contents,",
  "    'sizeBytes': len(data),",
  "    'isBinary': False,",
  "    'truncated': False,",
  "    'unsupportedReason': None,",
  "}))",
  "PY",
].join("\n");

const DOWNLOAD_THREAD_WORKSPACE_FILE_SCRIPT = [
  "python3 - <<'PY'",
  "import base64",
  "import json",
  "import os",
  "",
  "target_path = os.environ['T3_THREAD_WORKSPACE_TARGET_PATH']",
  "max_bytes = int(os.environ.get('T3_THREAD_WORKSPACE_DOWNLOAD_LIMIT', '8388608'))",
  "",
  "if not os.path.exists(target_path):",
  "    raise SystemExit(f'Path does not exist: {target_path}')",
  "if not os.path.isfile(target_path):",
  "    raise SystemExit(f\"'{target_path}' is not a file.\")",
  "",
  "size_bytes = os.path.getsize(target_path)",
  "if size_bytes > max_bytes:",
  "    raise SystemExit(f'Files larger than {max_bytes // (1024 * 1024)} MB cannot be downloaded here yet.')",
  "",
  "with open(target_path, 'rb') as file_handle:",
  "    data = file_handle.read()",
  "",
  "normalized_path = os.path.normpath(target_path)",
  "download_name = os.path.basename(normalized_path) or 'download'",
  "print(json.dumps({",
  "    'path': normalized_path,",
  "    'name': download_name,",
  "    'contentsBase64': base64.b64encode(data).decode('ascii'),",
  "}))",
  "PY",
].join("\n");

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const WRITE_THREAD_WORKSPACE_FILE_PYTHON = [
  "import json",
  "import os",
  "import sys",
  "",
  "with open(sys.argv[1], 'r', encoding='utf-8') as payload_file:",
  "    payload = json.load(payload_file)",
  "",
  "target_path = payload['path']",
  "contents = payload['contents']",
  "parent = os.path.dirname(target_path) or '/'",
  "os.makedirs(parent, exist_ok=True)",
  "with open(target_path, 'w', encoding='utf-8') as file_handle:",
  "    file_handle.write(contents)",
  "print(json.dumps({'path': os.path.normpath(target_path)}))",
].join("\n");

const WRITE_THREAD_WORKSPACE_FILE_SCRIPT = [
  'payload_file="$(mktemp)"',
  "trap 'rm -f \"$payload_file\"' EXIT",
  'cat > "$payload_file"',
  `python3 -c ${shellQuote(WRITE_THREAD_WORKSPACE_FILE_PYTHON)} "$payload_file"`,
].join("\n");

function toThreadWorkspaceError(message: string, cause?: unknown): ThreadWorkspaceServiceError {
  return new ThreadWorkspaceServiceError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function normalizeContainerPath(
  pathValue: string | undefined,
  execution: ThreadExecutionContext,
): string {
  const workspaceRoot = execution.workspacePath || DEFAULT_CONTAINER_WORKSPACE_PATH;
  const trimmed = pathValue?.trim();
  if (!trimmed) {
    return workspaceRoot;
  }
  const logicalProjectPath = parseLogicalProjectWorkspacePath(trimmed);
  if (logicalProjectPath) {
    if (!logicalProjectPath.relativePath) {
      return workspaceRoot;
    }
    const mappedPath = nodePath.posix.normalize(
      nodePath.posix.join(workspaceRoot, logicalProjectPath.relativePath),
    );
    return mappedPath === workspaceRoot || mappedPath.startsWith(`${workspaceRoot}/`)
      ? mappedPath
      : workspaceRoot;
  }
  if (trimmed === "~") {
    return nodePath.posix.normalize(execution.homePath || DEFAULT_CONTAINER_HOME_PATH);
  }
  if (trimmed.startsWith("~/")) {
    return nodePath.posix.normalize(
      nodePath.posix.join(execution.homePath || DEFAULT_CONTAINER_HOME_PATH, trimmed.slice(2)),
    );
  }
  if (trimmed.startsWith("/")) {
    return nodePath.posix.normalize(trimmed);
  }
  return nodePath.posix.normalize(
    nodePath.posix.join(execution.workspacePath || DEFAULT_CONTAINER_WORKSPACE_PATH, trimmed),
  );
}

function parseJsonOutput<T>(stdout: string, label: string, decode: (input: unknown) => T): T {
  try {
    return decode(JSON.parse(stdout));
  } catch (cause) {
    throw toThreadWorkspaceError(`Failed to parse ${label}.`, cause);
  }
}

export const makeThreadWorkspace = Effect.gen(function* () {
  const threadRuntime = yield* ThreadRuntime;

  const resolveLaunchContext = Effect.fn("threadWorkspace.resolveLaunchContext")(function* (
    threadId: ThreadId,
  ) {
    return yield* threadRuntime
      .resolveLaunchContext(threadId)
      .pipe(
        Effect.mapError((cause) =>
          toThreadWorkspaceError(`Thread runtime is unavailable for '${threadId}'.`, cause),
        ),
      );
  });

  const runInRuntime = Effect.fn("threadWorkspace.runInRuntime")(function* (input: {
    readonly launchContext: ThreadRuntimeLaunchContext;
    readonly threadId: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
  }) {
    const env = input.env ? { ...process.env, ...input.env } : process.env;
    const options: ProcessRunOptions = {
      cwd: input.launchContext.hostWorkspacePath,
      env,
      timeoutMs: input.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      maxBufferBytes: input.maxBufferBytes ?? DEFAULT_PROCESS_BUFFER_BYTES,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    };

    const result = yield* Effect.tryPromise({
      try: () => runProcess(input.launchContext.shellWrapperPath, input.args, options),
      catch: (cause) =>
        toThreadWorkspaceError(
          `Failed to execute '${input.args.join(" ")}' in thread '${input.threadId}'.`,
          cause,
        ),
    });

    return result;
  });

  const listEntries: ThreadWorkspaceShape["listEntries"] = Effect.fn("threadWorkspace.listEntries")(
    function* (input) {
      const launchContext = yield* resolveLaunchContext(input.threadId);
      const basePath = normalizeContainerPath(input.basePath, launchContext.execution);
      const result = yield* runInRuntime({
        launchContext,
        threadId: input.threadId,
        args: ["-lc", LIST_THREAD_WORKSPACE_SCRIPT],
        env: {
          T3_THREAD_WORKSPACE_BASE_PATH: basePath,
          T3_THREAD_WORKSPACE_QUERY: normalizeSearchQuery(input.query),
          T3_THREAD_WORKSPACE_LIMIT: String(input.limit),
        },
      });

      return parseJsonOutput(
        result.stdout,
        "thread workspace directory listing",
        Schema.decodeUnknownSync(ThreadWorkspaceEntriesResultSchema),
      );
    },
  );

  const readFile: ThreadWorkspaceShape["readFile"] = Effect.fn("threadWorkspace.readFile")(
    function* (input) {
      const launchContext = yield* resolveLaunchContext(input.threadId);
      const targetPath = normalizeContainerPath(input.path, launchContext.execution);
      const result = yield* runInRuntime({
        launchContext,
        threadId: input.threadId,
        args: ["-lc", READ_THREAD_WORKSPACE_FILE_SCRIPT],
        env: {
          T3_THREAD_WORKSPACE_TARGET_PATH: targetPath,
          T3_THREAD_WORKSPACE_TEXT_LIMIT: String(MAX_TEXT_FILE_BYTES),
        },
      });

      return parseJsonOutput<ThreadWorkspaceReadFileResult>(
        result.stdout,
        "thread workspace file contents",
        Schema.decodeUnknownSync(ThreadWorkspaceReadFileResultSchema),
      );
    },
  );

  const writeFile: ThreadWorkspaceShape["writeFile"] = Effect.fn("threadWorkspace.writeFile")(
    function* (input) {
      const launchContext = yield* resolveLaunchContext(input.threadId);
      const targetPath = normalizeContainerPath(input.path, launchContext.execution);
      const result = yield* runInRuntime({
        launchContext,
        threadId: input.threadId,
        args: ["-lc", WRITE_THREAD_WORKSPACE_FILE_SCRIPT],
        stdin: JSON.stringify({
          path: targetPath,
          contents: input.contents,
        }),
      });

      return parseJsonOutput(
        result.stdout,
        "thread workspace write result",
        Schema.decodeUnknownSync(ThreadWorkspaceWriteFileResultSchema),
      );
    },
  );

  const downloadFile: ThreadWorkspaceShape["downloadFile"] = Effect.fn(
    "threadWorkspace.downloadFile",
  )(function* (input) {
    const launchContext = yield* resolveLaunchContext(input.threadId);
    const targetPath = normalizeContainerPath(input.path, launchContext.execution);
    const result = yield* runInRuntime({
      launchContext,
      threadId: input.threadId,
      args: ["-lc", DOWNLOAD_THREAD_WORKSPACE_FILE_SCRIPT],
      env: {
        T3_THREAD_WORKSPACE_TARGET_PATH: targetPath,
        T3_THREAD_WORKSPACE_DOWNLOAD_LIMIT: String(MAX_DOWNLOAD_FILE_BYTES),
      },
      maxBufferBytes: 20 * 1_024 * 1_024,
    });

    const payload = parseJsonOutput(
      result.stdout,
      "thread workspace download payload",
      Schema.decodeUnknownSync(ThreadWorkspaceDownloadPayloadSchema),
    );

    return {
      path: payload.path,
      name: payload.name,
      bytes: Uint8Array.from(Buffer.from(payload.contentsBase64, "base64")),
    } satisfies ThreadWorkspaceDownloadFileResult;
  });

  return {
    listEntries,
    readFile,
    writeFile,
    downloadFile,
  } satisfies ThreadWorkspaceShape;
});

export const ThreadWorkspaceLive = Layer.effect(ThreadWorkspace, makeThreadWorkspace);
