import type {
  ProjectCheck,
  ProjectCheckCreateInput,
  ProjectCheckListResult,
  ProjectCheckReportInput,
  ProjectCheckReportResult,
  ProjectCheckRunNowResult,
  ProjectCheckRunsResult,
  ProjectCheckUpdateInput,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

export class HomelabChecksError extends Schema.TaggedError<HomelabChecksError>()(
  "HomelabChecksError",
  {
    message: Schema.String,
    reason: Schema.Literals(["not-found", "invalid-input", "conflict", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface HomelabChecksShape {
  /** Every check, or one project's. */
  readonly list: (filter?: {
    readonly projectId?: ProjectId;
  }) => Effect.Effect<ProjectCheckListResult, HomelabChecksError>;
  /** Fails for the hidden namespaces and projects that don't exist. */
  readonly create: (
    projectId: ProjectId,
    input: ProjectCheckCreateInput,
  ) => Effect.Effect<ProjectCheck, HomelabChecksError>;
  readonly update: (
    checkId: string,
    input: ProjectCheckUpdateInput,
  ) => Effect.Effect<ProjectCheck, HomelabChecksError>;
  /** Deletes the check and its history. Its thread stays. */
  readonly remove: (checkId: string) => Effect.Effect<void, HomelabChecksError>;
  /** Starts a run now. Fails with `conflict` while one is in flight. */
  readonly runNow: (checkId: string) => Effect.Effect<ProjectCheckRunNowResult, HomelabChecksError>;
  /** Clears "needs attention" until the next attention or failed result. */
  readonly acknowledge: (checkId: string) => Effect.Effect<ProjectCheck, HomelabChecksError>;
  readonly history: (
    checkId: string,
    limit?: number,
  ) => Effect.Effect<ProjectCheckRunsResult, HomelabChecksError>;
  /**
   * `homelab_check_report`: records the result on the check whose thread is
   * `threadId`. Fails for any other thread, and for a second report in the
   * same run.
   */
  readonly report: (
    threadId: ThreadId,
    input: ProjectCheckReportInput,
  ) => Effect.Effect<ProjectCheckReportResult, HomelabChecksError>;
  /** True when `threadId` is some check's own thread. */
  readonly isCheckThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  /** Starts the scheduler and the turn watcher in the given scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class HomelabChecks extends Context.Service<HomelabChecks, HomelabChecksShape>()(
  "t3/homelab/Services/HomelabChecks",
) {}
