/**
 * The homelab MCP toolkit: the agent-facing `homelab` CLI commands as typed
 * MCP tools, so runtime agents see them as native tools.
 *
 * Every tool acts for the thread its MCP credential was issued to and is
 * scoped exactly like that thread's runtime token (`thread-runtime:<id>`):
 * project memory, skills, and the runtime tools list belong to the thread's
 * project (scratch and curator threads: to the thread itself), and the
 * global graph is shared. Inputs never name a project or thread; the scope
 * comes from the credential.
 *
 * Deliberately left on the CLI: `homelab secret get` (an MCP result lands in
 * the transcript, so secret values never go through MCP), the curator-only
 * `homelab curate` surface, and the bootstrap catalog.
 *
 * @module mcp/toolkits/homelab/tools
 */
import {
  HomelabEntity,
  HomelabEntityUpsertInput,
  HomelabEntityVerifyInput,
  HomelabGraphSearchInput,
  HomelabGraphSearchResult,
  HomelabKnowledgeShowResult,
  HomelabPromotionEnvelope,
  HomelabPromotionRecorded,
  HomelabSecretDelivery,
  HomelabSecretRequestInput,
  HomelabSkill,
  HomelabSkillCreateInput,
  HomelabSkillPromoteInput,
  HomelabSnapshot,
  IsoDateTime,
  ProjectMemoryCreateInput,
  ProjectMemoryEntry,
  ProjectMemoryId,
  ProjectMemoryListInput,
  ProjectMemoryListResult,
  ProjectMemorySearchInput,
  ProjectMemorySearchResultList,
  RuntimeToolAddInput,
  RuntimeToolAddResult,
  RuntimeToolListResult,
  RuntimeToolRemoveInput,
  RuntimeToolRemoveResult,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Any homelab tool failure. The message is the same one the HTTP route would return. */
export class HomelabToolError extends Schema.TaggedError<HomelabToolError>()("HomelabToolError", {
  message: Schema.String,
}) {}

const SCOPE_NOTE =
  "Scoped to this thread's project (scratch and curator threads: to this thread); the scope comes from your session, not from arguments.";

/**
 * A promotion envelope as the agent writes it: `threadId` is always this
 * thread and `createdAt` defaults to now, so neither is required.
 */
export const HomelabToolPromotionEnvelope = Schema.Struct({
  ...HomelabPromotionEnvelope.fields,
  threadId: Schema.optional(ThreadId).annotate({
    description: "Ignored: always set to this thread.",
  }),
  createdAt: Schema.optional(IsoDateTime).annotate({
    description: "ISO-8601 timestamp. Defaults to now.",
  }),
});
export type HomelabToolPromotionEnvelope = typeof HomelabToolPromotionEnvelope.Type;

/** What `homelab_secret_list` reports per secret. Never a value. */
export const HomelabToolSecret = Schema.Struct({
  key: Schema.String,
  label: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  hasValue: Schema.Boolean.annotate({ description: "A value is stored on the server." }),
  pending: Schema.Boolean.annotate({
    description: "A value was requested and not yet supplied or declined.",
  }),
  declined: Schema.Boolean.annotate({ description: "The last request was declined by the user." }),
  delivery: HomelabSecretDelivery.annotate({
    description:
      "file: the real value is in the env var and the file. brokered: both hold a surrogate that the egress proxy swaps for the real value on HTTP(S) requests to allowedHosts.",
  }),
  envVar: Schema.String.annotate({ description: "Environment variable new shells get." }),
  file: Schema.String.annotate({
    description: "File holding the delivered value; readable by already-running processes.",
  }),
  allowedHosts: Schema.optional(Schema.Array(Schema.String)),
});
export type HomelabToolSecret = typeof HomelabToolSecret.Type;

export const HomelabToolSecretListResult = Schema.Struct({
  secrets: Schema.Array(HomelabToolSecret),
  howToRead: Schema.String,
});
export type HomelabToolSecretListResult = typeof HomelabToolSecretListResult.Type;

const readOnlyHints = (title: string) =>
  Context.make(Tool.Title, title).pipe(
    Context.add(Tool.Readonly, true),
    Context.add(Tool.Destructive, false),
    Context.add(Tool.Idempotent, true),
    Context.add(Tool.OpenWorld, false),
  );

const writeHints = (
  title: string,
  options: { readonly destructive: boolean; readonly idempotent: boolean },
) =>
  Context.make(Tool.Title, title).pipe(
    Context.add(Tool.Readonly, false),
    Context.add(Tool.Destructive, options.destructive),
    Context.add(Tool.Idempotent, options.idempotent),
    Context.add(Tool.OpenWorld, false),
  );

const SnapshotTool = Tool.make("homelab_snapshot", {
  description:
    "Return the full global homelab knowledge graph: every entity, relation, and observation. It can be large; prefer homelab_knowledge_search for a specific host or service.",
  success: HomelabSnapshot,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("Homelab graph snapshot"));

const KnowledgeSearchTool = Tool.make("homelab_knowledge_search", {
  description:
    "Search the global homelab knowledge graph (hosts, services, networks, and so on), ranked by match, recency and confidence. Check here before assuming anything about the infrastructure.",
  parameters: HomelabGraphSearchInput,
  success: Schema.Struct({ results: Schema.Array(HomelabGraphSearchResult) }),
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("Search homelab knowledge"));

const KnowledgeShowTool = Tool.make("homelab_knowledge_show", {
  description: `Show one knowledge document by id (a graph entity, an observation, or a memory note) with its links and recent audit history. Memory notes outside your scope read as not found. ${SCOPE_NOTE}`,
  parameters: Schema.Struct({
    id: TrimmedNonEmptyString.annotate({
      description: "Document id, as returned by search or list results.",
    }),
  }),
  success: HomelabKnowledgeShowResult,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("Show knowledge document"));

const MemorySearchTool = Tool.make("homelab_memory_search", {
  description: `Search project memory (durable notes from earlier threads) and, unless includeTranscripts is false, raw transcript indexes. ${SCOPE_NOTE}`,
  parameters: Schema.Struct({
    query: ProjectMemorySearchInput.fields.query,
    includeTranscripts: ProjectMemorySearchInput.fields.includeTranscripts,
    includeSuperseded: ProjectMemorySearchInput.fields.includeSuperseded,
    limit: ProjectMemorySearchInput.fields.limit,
  }),
  success: ProjectMemorySearchResultList,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("Search project memory"));

const MemoryListTool = Tool.make("homelab_memory_list", {
  description: `List durable project memory entries, newest first. ${SCOPE_NOTE}`,
  parameters: Schema.Struct({
    promotionStatus: ProjectMemoryListInput.fields.promotionStatus,
    limit: ProjectMemoryListInput.fields.limit,
  }),
  success: ProjectMemoryListResult,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("List project memory"));

const MemoryAddTool = Tool.make("homelab_memory_add", {
  description: `Save a durable project memory entry (a finding, decision, or gotcha worth keeping for later threads). Set propose=true to flag it for explicit promotion into the global graph (not available in scratch or curator threads). ${SCOPE_NOTE}`,
  parameters: Schema.Struct({
    summary: ProjectMemoryCreateInput.fields.summary,
    body: ProjectMemoryCreateInput.fields.body,
    tags: ProjectMemoryCreateInput.fields.tags,
    supersedes: ProjectMemoryCreateInput.fields.supersedes,
    replaces: ProjectMemoryCreateInput.fields.replaces,
    sourceFilePath: ProjectMemoryCreateInput.fields.sourceFilePath,
    id: ProjectMemoryCreateInput.fields.id,
    propose: Schema.optional(Schema.Boolean).annotate({
      description: "Flag the entry as proposed for global promotion. Defaults to false.",
    }),
  }),
  success: ProjectMemoryEntry,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Add project memory", { destructive: false, idempotent: false }));

const MemoryPromoteTool = Tool.make("homelab_memory_promote", {
  description: `Promote a proposed project memory entry: apply the promotion envelope to the global graph and mark the entry promoted, atomically. Not available in scratch or curator threads. ${SCOPE_NOTE}`,
  parameters: Schema.Struct({
    memoryId: ProjectMemoryId,
    promotion: HomelabToolPromotionEnvelope,
  }),
  success: Schema.Struct({
    recorded: HomelabPromotionRecorded,
    entry: Schema.optional(ProjectMemoryEntry),
  }),
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Promote project memory", { destructive: false, idempotent: true }));

const PromoteTool = Tool.make("homelab_promote", {
  description:
    "Publish durable, verified findings to the global homelab graph: upsert entities and relations and record observations in one envelope. Use stable, human-readable ids and prefer existing kinds. Only promote what you verified.",
  parameters: HomelabToolPromotionEnvelope,
  success: HomelabPromotionRecorded,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Promote to homelab graph", { destructive: false, idempotent: true }));

const EntityRecordTool = Tool.make("homelab_entity_record", {
  description:
    "Create or refresh one global graph entity by kind and name (the id is derived from both). Lighter than homelab_promote for a single entity.",
  parameters: HomelabEntityUpsertInput,
  success: HomelabEntity,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Record homelab entity", { destructive: false, idempotent: true }));

const EntityVerifyTool = Tool.make("homelab_entity_verify", {
  description:
    "Record that you probed an existing entity: reachable=true raises its confidence and marks it active, false lowers its confidence.",
  parameters: HomelabEntityVerifyInput,
  success: HomelabEntity,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Verify homelab entity", { destructive: false, idempotent: false }));

const SecretListTool = Tool.make("homelab_secret_list", {
  description:
    "List the secrets this runtime receives: key, delivery mode, env var and file. Never returns values. Read a value in a shell with `homelab secret get KEY` or from $KEY; don't print it into the conversation.",
  success: HomelabToolSecretListResult,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("List homelab secrets"));

const SecretRequestTool = Tool.make("homelab_secret_request", {
  description:
    "Ask the user to supply (or rotate) a secret in the app. Returns at once; the user fills it in the UI. Then check homelab_secret_list until hasValue is true and pending is false (declined=true means stop and ask the user), or run `homelab secret-request KEY` in a shell to wait for delivery.",
  parameters: Schema.Struct({
    key: HomelabSecretRequestInput.fields.key,
    label: HomelabSecretRequestInput.fields.label,
    summary: HomelabSecretRequestInput.fields.summary,
  }),
  success: HomelabToolSecret,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Request homelab secret", { destructive: false, idempotent: true }));

const SkillListTool = Tool.make("homelab_skill_list", {
  description: `List the homelab skills (SKILL.md playbooks) visible here, with their bodies. ${SCOPE_NOTE}`,
  success: Schema.Struct({ skills: Schema.Array(HomelabSkill) }),
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("List homelab skills"));

const SkillAddTool = Tool.make("homelab_skill_add", {
  description: `Author or update (by name) a skill at this thread's scope. It reaches running runtimes' skill folders within a moment. ${SCOPE_NOTE}`,
  parameters: Schema.Struct({
    name: HomelabSkillCreateInput.fields.name,
    description: HomelabSkillCreateInput.fields.description,
    body: HomelabSkillCreateInput.fields.body.annotate({ description: "SKILL.md content." }),
  }),
  success: HomelabSkill,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Add homelab skill", { destructive: false, idempotent: true }));

const SkillPromoteTool = Tool.make("homelab_skill_promote", {
  description: `Promote a skill to the project or to every runtime (global). ${SCOPE_NOTE}`,
  parameters: Schema.Struct({
    name: HomelabSkillPromoteInput.fields.name,
    to: HomelabSkillPromoteInput.fields.to,
  }),
  success: HomelabSkill,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Promote homelab skill", { destructive: false, idempotent: true }));

const ToolsListTool = Tool.make("homelab_tools_list", {
  description:
    "List the system tools recorded for this runtime. They are baked into its image, so they survive container rebuilds.",
  success: RuntimeToolListResult,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(readOnlyHints("List runtime tools"));

const ToolsAddTool = Tool.make("homelab_tools_add", {
  description:
    "Record a system tool this runtime needs (apt:<pkg>, pip:<pkg>, npm:<pkg>, or 'url:<https url> <dest>') so it survives container rebuilds. This only records it: run the returned installCommands in a shell now, and if they fail, call homelab_tools_remove. `homelab tools add` in a shell does both in one step.",
  parameters: Schema.Struct({
    spec: RuntimeToolAddInput.fields.spec,
    reason: RuntimeToolAddInput.fields.reason.annotate({
      description: "Why this runtime needs the tool.",
    }),
  }),
  success: RuntimeToolAddResult,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Add runtime tool", { destructive: false, idempotent: true }));

const ToolsRemoveTool = Tool.make("homelab_tools_remove", {
  description:
    "Remove a tool from this runtime's recorded list. The running container keeps it until the next rebuild.",
  parameters: Schema.Struct({ spec: RuntimeToolRemoveInput.fields.spec }),
  success: RuntimeToolRemoveResult,
  failure: HomelabToolError,
  dependencies,
}).annotateMerge(writeHints("Remove runtime tool", { destructive: true, idempotent: true }));

export const HomelabToolkit = Toolkit.make(
  SnapshotTool,
  KnowledgeSearchTool,
  KnowledgeShowTool,
  MemorySearchTool,
  MemoryListTool,
  MemoryAddTool,
  MemoryPromoteTool,
  PromoteTool,
  EntityRecordTool,
  EntityVerifyTool,
  SecretListTool,
  SecretRequestTool,
  SkillListTool,
  SkillAddTool,
  SkillPromoteTool,
  ToolsListTool,
  ToolsAddTool,
  ToolsRemoveTool,
);
