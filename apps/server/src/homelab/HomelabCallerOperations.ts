// @effect-diagnostics globalDate:off globalDateInEffect:off
/**
 * Caller-scoped homelab operations shared by the HTTP routes (`http.ts`, the
 * in-container `homelab` CLI) and the homelab MCP toolkit
 * (`mcp/toolkits/homelab`).
 *
 * Every operation takes a `HomelabCallerScope`. HTTP derives it from the
 * session subject (`thread-runtime:<threadId>` runtime tokens are pinned to
 * their thread's project; human sessions are unrestricted). MCP derives it
 * from the provider session's thread, the same way, so both entry points
 * enforce one set of scoping rules.
 *
 * Failures are domain errors from the services plus `HomelabHttpError`, a
 * status-coded error the HTTP routes turn into responses and the MCP toolkit
 * turns into tool errors.
 *
 * @module HomelabCallerOperations
 */
import {
  HomelabEntityId,
  type HomelabEntity,
  type HomelabEntityUpsertInput,
  type HomelabEntityVerifyInput,
  type HomelabSecretRequestInput,
  type HomelabSkillCreateInput,
  type HomelabSkillListInput,
  type HomelabSkillPromoteInput,
  type ProjectId,
  type ProjectMemoryCreateInput,
  type ProjectMemoryListInput,
  type ProjectMemoryPromoteInput,
  type ProjectMemorySearchInput,
  type RuntimeSessionId,
  type RuntimeTool,
  type RuntimeToolAddInput,
  type RuntimeToolAddResult,
  type RuntimeToolRemoveInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isCuratorProjectId, isStandaloneProjectId } from "../runtime/ProjectRuntimePolicy.ts";
import {
  RuntimeRegistry,
  runtimeToolsListKeyFor,
  type RuntimeToolRow,
  type RuntimeToolsListKey,
} from "../runtime/RuntimeRegistry.ts";
import {
  installCommandsForTool,
  parseRuntimeToolSpec,
  runtimeToolKindOf,
} from "../runtime/RuntimeTools.ts";
import { promoteDiscoveries } from "./PromotedDiscoveries.ts";
import { HomelabNotifier } from "./Services/HomelabNotifier.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";
import { HomelabSkills } from "./Services/HomelabSkills.ts";
import { KnowledgeGraph } from "./Services/KnowledgeGraph.ts";
import { ProjectMemory } from "./Services/ProjectMemory.ts";

/** A homelab request failure with the HTTP status it maps to. */
export class HomelabHttpError extends Data.TaggedError("HomelabHttpError")<{
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

const decodeHomelabEntityId = Schema.decodeUnknownSync(HomelabEntityId);

const SCRATCH_NO_PROJECT_DETAIL =
  "This is a standalone (scratch) thread: there is no project to propose or promote into. " +
  "Use 'homelab promote' to publish durable findings straight to the global homelab graph, " +
  "or promote this thread to a project first.";

const CURATOR_NO_PROJECT_DETAIL =
  "This is a knowledge curator session: there is no project to propose or promote into. " +
  "Correct the durable record directly with 'homelab curate' mutations, or upsert through " +
  "'homelab promote'.";

export const requireProjectScopeForPromotion = (projectId: ProjectId) =>
  isStandaloneProjectId(projectId)
    ? Effect.fail(new HomelabHttpError({ message: SCRATCH_NO_PROJECT_DETAIL, status: 400 }))
    : isCuratorProjectId(projectId)
      ? Effect.fail(new HomelabHttpError({ message: CURATOR_NO_PROJECT_DETAIL, status: 400 }))
      : Effect.void;

export const lookupActiveThreadProjectId = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Failed to resolve thread for homelab request.",
            status: 500,
            cause,
          }),
      ),
    );
    return Option.map(thread, (entry) => entry.projectId);
  });

/** Subject of the in-container runtime bearer token, minted by ThreadRuntime. */
export const RUNTIME_TOKEN_SUBJECT_PREFIX = "thread-runtime:";

/**
 * Who is calling a project/thread-scoped homelab operation. Human sessions are
 * `unrestricted`; runtime callers are pinned to the project of their thread,
 * and scratch/curator runtimes (always isolated) additionally to that thread.
 */
export type HomelabCallerScope =
  | { readonly kind: "unrestricted" }
  | {
      readonly kind: "runtime";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly threadScoped: boolean;
    };

/** A caller acting for one thread: a runtime token or an MCP provider session. */
export type ThreadCallerScope = Extract<HomelabCallerScope, { readonly kind: "runtime" }>;

const UNRESTRICTED_CALLER: HomelabCallerScope = { kind: "unrestricted" };

/** Caller scope of an agent acting for `threadId` (runtime token or MCP session). */
export const resolveThreadCallerScope = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectId = yield* lookupActiveThreadProjectId(threadId);
    if (Option.isNone(projectId)) {
      return yield* new HomelabHttpError({
        message: "Runtime token thread no longer exists.",
        status: 403,
      });
    }
    const caller: ThreadCallerScope = {
      kind: "runtime",
      threadId,
      projectId: projectId.value,
      threadScoped: isStandaloneProjectId(projectId.value) || isCuratorProjectId(projectId.value),
    };
    return caller;
  });

export const resolveHomelabCallerScope = (session: {
  readonly subject: string;
}): Effect.Effect<HomelabCallerScope, HomelabHttpError, ProjectionSnapshotQuery> =>
  session.subject.startsWith(RUNTIME_TOKEN_SUBJECT_PREFIX)
    ? resolveThreadCallerScope(
        ThreadId.make(session.subject.slice(RUNTIME_TOKEN_SUBJECT_PREFIX.length)),
      )
    : Effect.succeed(UNRESTRICTED_CALLER);

export const forbiddenScope = (message: string) => new HomelabHttpError({ message, status: 403 });

/**
 * Resolves the project (and effective thread) a memory/skill request operates on.
 * For runtime callers, request params may only narrow the caller's scope, never widen it,
 * and thread-scoped (scratch/curator) runtimes always get their own thread applied.
 */
export const resolveMemoryRequestScope = (
  caller: HomelabCallerScope,
  input: {
    readonly projectId?: ProjectId | undefined;
    readonly threadId?: ThreadId | undefined;
  },
) =>
  Effect.gen(function* () {
    if (caller.kind === "runtime") {
      if (input.projectId !== undefined && input.projectId !== caller.projectId) {
        return yield* forbiddenScope("Runtime tokens may only access their own project.");
      }
      if (caller.threadScoped) {
        if (input.threadId !== undefined && input.threadId !== caller.threadId) {
          return yield* forbiddenScope("Runtime tokens may only access their own thread.");
        }
        return { projectId: caller.projectId, threadId: caller.threadId };
      }
      // Shared project runtimes serve several threads with one token; any of them is fine.
      if (input.threadId !== undefined && input.threadId !== caller.threadId) {
        const threadProjectId = yield* lookupActiveThreadProjectId(input.threadId);
        if (Option.isNone(threadProjectId) || threadProjectId.value !== caller.projectId) {
          return yield* forbiddenScope("Runtime tokens may only access their own project.");
        }
      }
      return { projectId: caller.projectId, threadId: input.threadId };
    }

    if (input.projectId) {
      return { projectId: input.projectId, threadId: input.threadId };
    }
    if (!input.threadId) {
      return yield* new HomelabHttpError({
        message: "Project memory requests must include projectId or threadId.",
        status: 400,
      });
    }
    const projectId = yield* lookupActiveThreadProjectId(input.threadId);
    if (Option.isNone(projectId)) {
      return yield* new HomelabHttpError({
        message: "Project memory thread not found.",
        status: 404,
      });
    }
    return { projectId: projectId.value, threadId: input.threadId };
  });

const optionalThreadId = (threadId: ThreadId | undefined) =>
  threadId !== undefined ? { threadId } : {};

// --- Knowledge -------------------------------------------------------------

/**
 * Any knowledge document (graph entity, observation, memory note) with its
 * links and recent audit rows. Global documents are visible to every caller;
 * project and thread memory follow the memory scoping rules, and an
 * out-of-scope id reads as not found.
 */
export const showKnowledgeDocument = (caller: HomelabCallerScope, id: string) =>
  Effect.gen(function* () {
    const knowledgeGraph = yield* KnowledgeGraph;
    const result = yield* knowledgeGraph.getDocument(id);
    const notFound = new HomelabHttpError({
      message: "Knowledge document not found.",
      status: 404,
    });
    if (!result) {
      return yield* notFound;
    }
    const { doc } = result;
    if (caller.kind === "runtime" && doc.scope !== "global") {
      const inScope =
        doc.projectId === String(caller.projectId) &&
        (!caller.threadScoped || doc.threadId === String(caller.threadId));
      if (!inScope) {
        return yield* notFound;
      }
    }
    return result;
  });

function normalizedEntityName(name: string): string {
  return name.trim().toLowerCase();
}

/** Create or refresh one global graph entity by kind and name (`homelab record`). */
export const upsertHomelabEntity = (input: HomelabEntityUpsertInput) =>
  Effect.gen(function* () {
    const knowledgeGraph = yield* KnowledgeGraph;
    const now = new Date().toISOString();
    const slug = normalizedEntityName(input.name).replace(/\s+/g, "-");
    const id = decodeHomelabEntityId(`${input.kind}:${slug}`);
    // Preserve createdAt across re-captures (id or natural-key match).
    const existing =
      (yield* knowledgeGraph.getEntity(id)) ??
      (yield* knowledgeGraph.findEntity({ kind: input.kind, name: input.name }));
    const entity: HomelabEntity = {
      id,
      kind: input.kind,
      name: input.name,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.properties !== undefined ? { properties: input.properties } : {}),
      confidence: input.confidence ?? existing?.confidence ?? 0.7,
      observedAt: now,
      lastVerifiedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    yield* knowledgeGraph.upsertEntity(entity);
    return entity;
  });

/** Stamp an entity's verification freshness after a probe (`homelab verify`). */
export const verifyHomelabEntity = (input: HomelabEntityVerifyInput) =>
  Effect.gen(function* () {
    const knowledgeGraph = yield* KnowledgeGraph;
    const match = yield* knowledgeGraph.findEntity({ kind: input.kind, name: input.name });
    if (!match) {
      return yield* new HomelabHttpError({
        message: `No entity named '${input.name}' to verify.`,
        status: 404,
      });
    }
    const now = new Date().toISOString();
    const priorConfidence = match.confidence ?? 0.5;
    const confidence = input.reachable
      ? Math.min(1, priorConfidence + 0.2)
      : Math.max(0, priorConfidence - 0.3);
    const verified: HomelabEntity = {
      ...match,
      // A single failed probe drops confidence but does not force "deprecated";
      // a reachable probe confirms the entity is active.
      ...(input.reachable ? { status: "active" as const } : {}),
      confidence,
      lastVerifiedAt: now,
      observedAt: now,
      updatedAt: now,
    };
    yield* knowledgeGraph.upsertEntity(verified);
    return verified;
  });

// --- Project memory ----------------------------------------------------------

export const listProjectMemory = (caller: HomelabCallerScope, input: ProjectMemoryListInput) =>
  Effect.gen(function* () {
    const scope = yield* resolveMemoryRequestScope(caller, input);
    const projectMemory = yield* ProjectMemory;
    return yield* projectMemory.list({
      ...input,
      projectId: scope.projectId,
      ...optionalThreadId(scope.threadId),
    });
  });

export const searchProjectMemory = (caller: HomelabCallerScope, input: ProjectMemorySearchInput) =>
  Effect.gen(function* () {
    const scope = yield* resolveMemoryRequestScope(caller, input);
    const projectMemory = yield* ProjectMemory;
    return yield* projectMemory.search({
      ...input,
      projectId: scope.projectId,
      ...optionalThreadId(scope.threadId),
    });
  });

export const createProjectMemory = (caller: HomelabCallerScope, input: ProjectMemoryCreateInput) =>
  Effect.gen(function* () {
    const scope = yield* resolveMemoryRequestScope(caller, {
      projectId: input.projectId,
      threadId: input.sourceThreadId,
    });
    if (input.promotionStatus === "proposed") {
      yield* requireProjectScopeForPromotion(scope.projectId);
    }
    const projectMemory = yield* ProjectMemory;
    return yield* projectMemory.create({
      ...input,
      projectId: scope.projectId,
      ...(scope.threadId !== undefined ? { sourceThreadId: scope.threadId } : {}),
    });
  });

/**
 * Promote a project memory entry into the global graph. Graph entries, memory
 * status, secret placeholders and bootstrap mutations commit together or not
 * at all.
 */
export const promoteProjectMemory = (
  caller: HomelabCallerScope,
  input: ProjectMemoryPromoteInput,
) =>
  Effect.gen(function* () {
    const { projectId } = yield* resolveMemoryRequestScope(caller, input);
    yield* requireProjectScopeForPromotion(projectId);
    return yield* promoteDiscoveries({
      promotion: input.promotion,
      memory: {
        memoryId: input.memoryId,
        projectId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
    });
  });

// --- Secrets -------------------------------------------------------------------

/** Runtime callers only see the secrets their project's runtimes receive. */
export const listCallerSecrets = (caller: HomelabCallerScope) =>
  Effect.gen(function* () {
    const registry = yield* HomelabSecretRegistry;
    return yield* registry.listSecrets(
      caller.kind === "runtime" ? { projectId: caller.projectId } : undefined,
    );
  });

export const requestCallerSecret = (caller: HomelabCallerScope, input: HomelabSecretRequestInput) =>
  Effect.gen(function* () {
    const registry = yield* HomelabSecretRegistry;
    // A runtime can only ask on behalf of its own thread.
    const threadId = caller.kind === "runtime" ? caller.threadId : input.threadId;
    const secret = yield* registry.requestSecret({
      key: input.key,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
    });
    if (secret.pending) yield* notifySecretRequested(secret.key, input, threadId);
    return secret;
  });

/** Tells the user a secret is waiting for a value. Never fails the request. */
const notifySecretRequested = (
  key: string,
  input: HomelabSecretRequestInput,
  threadId: ThreadId | undefined,
) =>
  Effect.gen(function* () {
    const notifier = yield* Effect.serviceOption(HomelabNotifier);
    if (Option.isNone(notifier)) return;
    const snapshots = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    const thread =
      threadId === undefined || Option.isNone(snapshots)
        ? undefined
        : yield* snapshots.value.getThreadShellById(threadId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
    const about = input.label ?? input.summary;
    yield* notifier.value.notify({
      kind: "secret-request",
      title: `Secret requested: ${key}`,
      body: [
        about,
        thread ? `Requested by ${thread.title}.` : undefined,
        "Add it in Settings → Secrets.",
      ]
        .filter((part) => part !== undefined)
        .join(" "),
      priority: 4,
      tags: ["key"],
      dedupKey: `${threadId ?? "-"}:${key}`,
      path: "/settings/secrets",
    });
  });

// --- Skills ----------------------------------------------------------------------

export const resolveSkillContext = (
  caller: HomelabCallerScope,
  input: {
    readonly projectId?: ProjectId | undefined;
    readonly threadId?: ThreadId | undefined;
  },
) =>
  Effect.gen(function* () {
    const { projectId, threadId } = yield* resolveMemoryRequestScope(caller, input);
    if (isStandaloneProjectId(projectId)) {
      if (!threadId) {
        return yield* new HomelabHttpError({
          message: "Scratch skill requests must include threadId.",
          status: 400,
        });
      }
      return { kind: "scratch", threadId } as const;
    }
    return { kind: "project", projectId } as const;
  });

export const listCallerSkills = (caller: HomelabCallerScope, input: HomelabSkillListInput) =>
  Effect.gen(function* () {
    const context = yield* resolveSkillContext(caller, input);
    const skills = yield* HomelabSkills;
    return yield* skills.listForContext(context);
  });

export const upsertCallerSkill = (caller: HomelabCallerScope, input: HomelabSkillCreateInput) =>
  Effect.gen(function* () {
    const context = yield* resolveSkillContext(caller, input);
    const skills = yield* HomelabSkills;
    return yield* skills.upsert({
      context,
      name: input.name,
      description: input.description,
      body: input.body,
    });
  });

export const promoteCallerSkill = (caller: HomelabCallerScope, input: HomelabSkillPromoteInput) =>
  Effect.gen(function* () {
    const context = yield* resolveSkillContext(caller, input);
    const skills = yield* HomelabSkills;
    return yield* skills.promote({ context, name: input.name, to: input.to });
  });

// --- Runtime tools (`homelab tools`, Settings -> Project Runtime) ---------------

const runtimeToolsStoreError = (cause: unknown) =>
  new HomelabHttpError({ message: "Failed to access the runtime tools list.", status: 500, cause });

/**
 * The tools list a request operates on. A runtime caller always gets the list
 * of the runtime its thread is bound to (its project's shared list, or an
 * isolated clone's own) and can't name another project or runtime. Human
 * callers name the project, and optionally one of its runtimes.
 */
export const resolveRuntimeToolsKey = (
  caller: HomelabCallerScope,
  input: {
    readonly projectId?: ProjectId | undefined;
    readonly runtimeId?: RuntimeSessionId | undefined;
  },
) =>
  Effect.gen(function* () {
    const registry = yield* RuntimeRegistry;
    if (caller.kind === "runtime") {
      if (input.projectId !== undefined && input.projectId !== caller.projectId) {
        return yield* forbiddenScope("Runtime tokens may only manage their own project's tools.");
      }
      const binding = yield* registry
        .getBinding(caller.threadId)
        .pipe(Effect.mapError(runtimeToolsStoreError));
      if (Option.isNone(binding)) {
        return yield* forbiddenScope("This thread is not bound to a runtime.");
      }
      if (input.runtimeId !== undefined && input.runtimeId !== binding.value.runtimeId) {
        return yield* forbiddenScope("Runtime tokens may only manage their own runtime's tools.");
      }
      const record = yield* registry
        .getRuntime(binding.value.runtimeId)
        .pipe(Effect.mapError(runtimeToolsStoreError));
      if (
        Option.isNone(record) ||
        (record.value.projectId !== null && record.value.projectId !== caller.projectId)
      ) {
        return yield* forbiddenScope("Runtime tokens may only manage their own project's tools.");
      }
      const key = runtimeToolsListKeyFor({ ...record.value, projectId: caller.projectId });
      if (key === undefined) {
        return yield* forbiddenScope("This runtime has no tools list.");
      }
      return key;
    }
    if (input.projectId === undefined) {
      return yield* new HomelabHttpError({
        message: "Runtime tools requests must include projectId.",
        status: 400,
      });
    }
    if (input.runtimeId === undefined) {
      const key: RuntimeToolsListKey = { projectId: input.projectId, runtimeId: null };
      return key;
    }
    const record = yield* registry
      .getRuntime(input.runtimeId)
      .pipe(Effect.mapError(runtimeToolsStoreError));
    const key = Option.isSome(record) ? runtimeToolsListKeyFor(record.value) : undefined;
    if (key === undefined || key.projectId !== input.projectId) {
      return yield* new HomelabHttpError({
        message: "That runtime does not belong to this project.",
        status: 404,
      });
    }
    return key;
  });

const toRuntimeToolView = (row: RuntimeToolRow): RuntimeTool | undefined => {
  const kind = runtimeToolKindOf(row.spec);
  return kind === undefined
    ? undefined
    : {
        projectId: row.projectId,
        runtimeId: row.runtimeId,
        spec: row.spec,
        kind,
        reason: row.reason,
        addedByThreadId: row.addedByThreadId,
        createdAt: row.createdAt,
      };
};

/** A human caller without a project gets every list (the settings overview). */
export const listRuntimeTools = (
  caller: HomelabCallerScope,
  input: {
    readonly projectId?: ProjectId | undefined;
    readonly runtimeId?: RuntimeSessionId | undefined;
  },
) =>
  Effect.gen(function* () {
    const registry = yield* RuntimeRegistry;
    const rows =
      caller.kind === "unrestricted" && input.projectId === undefined
        ? yield* registry.listTools().pipe(Effect.mapError(runtimeToolsStoreError))
        : yield* resolveRuntimeToolsKey(caller, input).pipe(
            Effect.flatMap((key) =>
              registry.listTools(key).pipe(Effect.mapError(runtimeToolsStoreError)),
            ),
          );
    return rows.flatMap((row) => {
      const view = toRuntimeToolView(row);
      return view ? [view] : [];
    });
  });

/** Record a tool on the caller's list. The list only shapes the next image; it never recreates. */
export const addRuntimeTool = (caller: HomelabCallerScope, input: RuntimeToolAddInput) =>
  Effect.gen(function* () {
    const parsed = parseRuntimeToolSpec(input.spec);
    if (!parsed.ok) {
      return yield* new HomelabHttpError({ message: parsed.error, status: 400 });
    }
    const key = yield* resolveRuntimeToolsKey(caller, input);
    const registry = yield* RuntimeRegistry;
    const row: RuntimeToolRow = {
      projectId: key.projectId,
      runtimeId: key.runtimeId ?? null,
      spec: parsed.tool.spec,
      reason: input.reason.trim(),
      addedByThreadId: caller.kind === "runtime" ? caller.threadId : null,
      createdAt: new Date().toISOString(),
    };
    const created = yield* registry.upsertTool(row).pipe(Effect.mapError(runtimeToolsStoreError));
    const tool = toRuntimeToolView(row);
    if (tool === undefined) {
      return yield* new HomelabHttpError({ message: "Invalid runtime tool spec.", status: 400 });
    }
    return {
      tool,
      created,
      installCommands: installCommandsForTool(parsed.tool).map((command) => [...command]),
    } satisfies RuntimeToolAddResult;
  });

export const removeRuntimeTool = (caller: HomelabCallerScope, input: RuntimeToolRemoveInput) =>
  Effect.gen(function* () {
    const key = yield* resolveRuntimeToolsKey(caller, input);
    const parsed = parseRuntimeToolSpec(input.spec);
    // Stored specs are canonical; an unparseable one is matched verbatim.
    const spec = parsed.ok ? parsed.tool.spec : input.spec.trim();
    const registry = yield* RuntimeRegistry;
    return yield* registry.deleteTool(key, spec).pipe(Effect.mapError(runtimeToolsStoreError));
  });
