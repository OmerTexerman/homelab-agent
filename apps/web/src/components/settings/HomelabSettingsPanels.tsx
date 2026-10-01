/**
 * Homelab settings pages: Secrets, Project Runtime, Memory & Knowledge and
 * Advanced. Rendered by the fork-owned `routes/settings.*` route files; kept
 * out of the upstream-owned `SettingsPanels.tsx`.
 */
import { useAtomValue } from "@effect/atom-react";
import { LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import {
  AuthHomelabCurateScope,
  DEFAULT_MODEL,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";

import { connectionAtomRuntime } from "../../connection/runtime";
import { describeHomelabError } from "../../homelab/homelabFetch";
import { createSingleFlight } from "../../homelab/homelabMutationCore";
import { ensureLocalApi } from "../../localApi";
import { useScopeGate } from "../../homelab/useScopeGate";
import { queryDisplayState } from "../../homelab/queryDisplayState";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  homelabAllMemoryQueryOptions,
  homelabAllSkillsQueryOptions,
  homelabCuratorOverviewQueryOptions,
  homelabSetupStatusQueryOptions,
} from "../../lib/homelabReactQuery";
import { newCommandId } from "../../homelab/commandIds";
import { waitForThreadShell } from "../../homelab/waitForThreadShell";
import { newMessageId, newThreadId } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { HOMELAB_PRODUCT_COPY, shouldShowPrimarySourceControlUi } from "../../productCapabilities";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ScopeRequiredNotice } from "../homelab/ScopeRequiredNotice";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { HomelabSecretsSection } from "./HomelabSecretsSection";
import { KnowledgeEstateBrowser } from "./KnowledgeEstateBrowser";
import { RuntimeCliUpdatesSection } from "./RuntimeCliUpdatesSection";
import { RuntimeToolsSection } from "./RuntimeToolsSection";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

// Generic orchestration-command dispatch used by the homelab curator launch flow.
// Mirrors the upstream environment RPC command atoms (see state/server.ts).
const dispatchHomelabOrchestrationCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "homelab:settings:dispatch-orchestration-command",
  tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
});

export function SecretsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <HomelabSecretsSection />
    </SettingsPageContainer>
  );
}

export function ProjectRuntimeSettingsPanel() {
  // The default runtime for new threads is upstream's scoped "New threads ->
  // Workspace" picker (General and per-project settings), relabeled through
  // `resolveHomelabThreadEnvModeLabel`, so there is one control for it.
  return (
    <SettingsPageContainer>
      <RuntimeCliUpdatesSection />
      <RuntimeToolsSection />
      <SettingsSection title={HOMELAB_PRODUCT_COPY.projectRuntime.title}>
        <SettingsRow
          title={HOMELAB_PRODUCT_COPY.projectRuntime.ownershipTitle}
          description={HOMELAB_PRODUCT_COPY.projectRuntime.ownershipDescription}
          control={
            <span className="inline-flex min-h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground">
              {HOMELAB_PRODUCT_COPY.projectRuntime.ownershipValue}
            </span>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function MemoryKnowledgeSettingsPanel() {
  const settings = usePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  // Launching/managing curator sessions and reading the knowledge estate need
  // homelab:curate (the scope curator runtimes carry and that gates the
  // /curate/* routes). Nothing curator-shaped renders or fetches until the
  // session proves the scope, so a device without it never fires silent 403s.
  const curateGate = useScopeGate(AuthHomelabCurateScope);
  const canCurate = curateGate === "granted";
  const { deleteThread } = useThreadActions();
  const dispatchCuratorCommand = useAtomCommand(dispatchHomelabOrchestrationCommand, {
    reportFailure: false,
  });
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const allProjects = useProjects();
  const allSidebarThreads = useThreadShells();
  // A project-scoped visit (a project page's "All memory") opens its memory.
  const scope = useOptionalSettingsScope()?.scope;
  const scopedMemoryProjectId =
    scope?.kind === "project" || scope?.kind === "checkout"
      ? (scope.members.find((member) => member.environmentId === primaryEnvironmentId)?.id ?? null)
      : null;
  const [isStartingCuratorSession, setIsStartingCuratorSession] = useState(false);
  const [curatorStartFlight] = useState(createSingleFlight);
  // The kickoff prompt auto-sends on launch, so the model/effort choice has to happen
  // here — there is no empty-composer moment to change it before the first turn.
  const curatorProject = useMemo(
    () =>
      allProjects.find(
        (project) =>
          project.environmentId === primaryEnvironmentId && isCuratorProjectId(project.id),
      ),
    [allProjects, primaryEnvironmentId],
  );
  const [pickedCuratorSelection, setPickedCuratorSelection] = useState<ModelSelection | null>(null);
  const curatorModelSelection: ModelSelection = useMemo(
    () =>
      pickedCuratorSelection ??
      curatorProject?.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      },
    [curatorProject?.defaultModelSelection, pickedCuratorSelection],
  );
  const curatorInstanceEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders)),
    [serverProviders],
  );
  const curatorInstanceEntry = curatorInstanceEntries.find(
    (entry) => entry.instanceId === curatorModelSelection.instanceId,
  );
  const curatorModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    curatorModelSelection.instanceId,
    curatorModelSelection.model,
  );
  const curatorSessions = useMemo(
    () =>
      allSidebarThreads
        .filter((thread) => isCuratorProjectId(thread.projectId) && thread.archivedAt === null)
        .toSorted((left, right) =>
          (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
        ),
    [allSidebarThreads],
  );
  const startCuratorSession = useCallback(() => {
    if (primaryEnvironmentId === null) {
      return;
    }
    // The flight guard, not React state, stops a synchronous double click.
    void curatorStartFlight.run(async () => {
      setIsStartingCuratorSession(true);
      try {
        const threadId = newThreadId();
        const modelSelection = curatorModelSelection;
        const createResult = await dispatchCuratorCommand({
          environmentId: primaryEnvironmentId,
          input: {
            type: "thread.curator.create",
            commandId: newCommandId(),
            threadId,
            title: HOMELAB_PRODUCT_COPY.curator.sessionTitle,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });
        if (createResult._tag === "Failure") {
          throw squashAtomCommandFailure(createResult);
        }
        // Kick the session off immediately: the curator persona's first move is a
        // knowledge inventory, so the opening sweep starts without an empty-composer stop.
        const startResult = await dispatchCuratorCommand({
          environmentId: primaryEnvironmentId,
          input: {
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: HOMELAB_PRODUCT_COPY.curator.kickoffPrompt,
              attachments: [],
            },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });
        if (startResult._tag === "Failure") {
          throw squashAtomCommandFailure(startResult);
        }
        // Remember the choice as the curator project default so the next session
        // starts from it (project creation only seeds the default on first launch).
        if (
          curatorProject &&
          !Equal.equals(curatorProject.defaultModelSelection ?? null, modelSelection)
        ) {
          // Best effort: ignore failures updating the remembered default.
          await dispatchCuratorCommand({
            environmentId: primaryEnvironmentId,
            input: {
              type: "project.meta.update",
              commandId: newCommandId(),
              projectId: curatorProject.id,
              defaultModelSelection: modelSelection,
            },
          });
        }
        const threadRef = scopeThreadRef(primaryEnvironmentId, threadId);
        await waitForThreadShell(threadRef);
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: HOMELAB_PRODUCT_COPY.curator.creationFailedTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } finally {
        setIsStartingCuratorSession(false);
      }
    }, undefined);
  }, [
    curatorModelSelection,
    curatorProject,
    curatorStartFlight,
    dispatchCuratorCommand,
    navigate,
    primaryEnvironmentId,
  ]);
  const homelabSetupStatusQuery = useQuery(
    homelabSetupStatusQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null,
    }),
  );
  const homelabAllMemoryQuery = useQuery(
    homelabAllMemoryQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null && canCurate,
    }),
  );
  const homelabAllSkillsQuery = useQuery(
    homelabAllSkillsQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null && canCurate,
    }),
  );
  const homelabCuratorOverviewQuery = useQuery(
    homelabCuratorOverviewQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null && canCurate,
    }),
  );
  const homelabSetupStatus = homelabSetupStatusQuery.data;
  const estateSnapshot = homelabSetupStatus?.snapshot;
  const estateMemoryEntries = homelabAllMemoryQuery.data?.entries ?? [];
  const estateSkills = homelabAllSkillsQuery.data?.skills ?? [];
  const bootstrapMutationCount = homelabSetupStatus?.runtimeBootstrap.mutations.length ?? 0;
  const estateLoading =
    homelabSetupStatusQuery.isLoading ||
    homelabAllMemoryQuery.isLoading ||
    homelabAllSkillsQuery.isLoading;
  const estateSnapshotState = queryDisplayState(homelabSetupStatusQuery, () => false);
  const estateError = [homelabSetupStatusQuery, homelabAllMemoryQuery, homelabAllSkillsQuery].find(
    (query) => query.isError,
  )?.error;
  const projectNameById = useMemo(
    () => new Map(allProjects.map((project) => [String(project.id), project.title])),
    [allProjects],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title={HOMELAB_PRODUCT_COPY.settings.memoryAndKnowledge}>
        <SettingsRow
          title={HOMELAB_PRODUCT_COPY.curator.settingsCardTitle}
          description={HOMELAB_PRODUCT_COPY.curator.settingsCardDescription}
          control={
            curateGate === "loading" ? (
              <span className="text-2xs text-muted-foreground">Checking permissions...</span>
            ) : !canCurate ? null : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={curatorModelSelection.instanceId}
                  model={curatorModelSelection.model}
                  lockedProvider={null}
                  instanceEntries={curatorInstanceEntries}
                  modelOptionsByInstance={curatorModelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) => {
                    setPickedCuratorSelection(createModelSelection(instanceId, model));
                  }}
                />
                <TraitsPicker
                  provider={curatorInstanceEntry?.driverKind ?? ProviderDriverKind.make("codex")}
                  models={curatorInstanceEntry?.models ?? []}
                  model={curatorModelSelection.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={curatorModelSelection.options ?? []}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={settings.planModeEnabled}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(nextOptions) => {
                    setPickedCuratorSelection(
                      createModelSelection(
                        curatorModelSelection.instanceId,
                        curatorModelSelection.model,
                        nextOptions,
                      ),
                    );
                  }}
                />
                <Button
                  size="sm"
                  onClick={startCuratorSession}
                  disabled={primaryEnvironmentId === null || isStartingCuratorSession}
                >
                  {isStartingCuratorSession ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  {HOMELAB_PRODUCT_COPY.curator.newSessionAction}
                </Button>
              </div>
            )
          }
        >
          {canCurate ? (
            <>
              {curatorSessions.length > 0 ? (
                <div className="mt-3 space-y-1 border-t border-border/60 pt-3">
                  <div className="text-2xs font-medium text-muted-foreground">
                    {HOMELAB_PRODUCT_COPY.curator.recentSessionsLabel}
                  </div>
                  {curatorSessions.slice(0, 8).map((thread) => (
                    <div
                      key={`${thread.environmentId}:${thread.id}`}
                      className="flex items-center gap-1 rounded-md border border-border pr-1 hover:bg-accent/50"
                    >
                      <Link
                        to="/$environmentId/$threadId"
                        params={buildThreadRouteParams(
                          scopeThreadRef(thread.environmentId, thread.id),
                        )}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-xs"
                      >
                        <span className="min-w-0 truncate text-foreground">{thread.title}</span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
                        </span>
                      </Link>
                      <Button
                        variant="ghost-destructive"
                        size="icon-sm"
                        aria-label={`Delete "${thread.title}"`}
                        className="shrink-0"
                        onClick={() => {
                          // Deleting the session destroys its isolated runtime container and
                          // storage server-side; the sidebar hides curator threads, so this is
                          // the cleanup surface. It cannot be undone, so always confirm.
                          void (async () => {
                            const confirmed = await ensureLocalApi().dialogs.confirm(
                              `Delete curator session "${thread.title}"? This permanently removes its conversation and its isolated runtime.`,
                              { variant: "destructive" },
                            );
                            if (confirmed) {
                              await deleteThread(scopeThreadRef(thread.environmentId, thread.id));
                            }
                          })();
                        }}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  {HOMELAB_PRODUCT_COPY.curator.emptySessionsLabel}
                </div>
              )}
              <div className="mt-2 text-2xs text-muted-foreground/80">
                {HOMELAB_PRODUCT_COPY.curator.autoCleanupNote}
              </div>
            </>
          ) : curateGate === "denied" ? (
            <ScopeRequiredNotice
              scope={AuthHomelabCurateScope}
              action="run or manage curator sessions"
              className="mt-3"
            />
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Knowledge estate"
          description="Everything the homelab durably knows: graph entities, relations, observations, every project's memory, and all skills. Search, filter, and expand any record."
          control={
            homelabCuratorOverviewQuery.data &&
            homelabCuratorOverviewQuery.data.staleEntityCount > 0 ? (
              <span className="inline-flex min-h-8 items-center rounded-md border border-warning/30 bg-warning/8 px-3 text-xs font-medium text-warning-foreground">
                {homelabCuratorOverviewQuery.data.staleEntityCount} stale entities
              </span>
            ) : (
              <span className="inline-flex min-h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground">
                {curateGate === "denied"
                  ? "Unavailable"
                  : estateLoading || curateGate === "loading" || estateSnapshotState === "loading"
                    ? "Loading"
                    : estateSnapshot
                      ? `Updated ${formatRelativeTimeLabel(estateSnapshot.updatedAt)}`
                      : "Unavailable"}
              </span>
            )
          }
        >
          <div className="mt-3 border-t border-border/60 pt-3">
            {curateGate === "denied" ? (
              <ScopeRequiredNotice
                scope={AuthHomelabCurateScope}
                action="browse the knowledge estate"
              />
            ) : (
              <KnowledgeEstateBrowser
                snapshot={
                  estateSnapshot ?? {
                    entities: [],
                    relations: [],
                    observations: [],
                    updatedAt: new Date(0).toISOString(),
                  }
                }
                memoryEntries={estateMemoryEntries}
                skills={estateSkills}
                staleEntityIds={homelabCuratorOverviewQuery.data?.staleEntityIds.map(String)}
                projectNameById={projectNameById}
                loading={estateLoading || curateGate === "loading"}
                initialMemoryProjectId={scopedMemoryProjectId}
              />
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Runtime bootstrap state"
          description="Project Runtime bootstrap mutations available through homelab tools."
          control={
            <span className="inline-flex min-h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground">
              {estateSnapshotState === "loading"
                ? "Loading"
                : estateSnapshotState === "error"
                  ? "Unavailable"
                  : `${bootstrapMutationCount} entries`}
            </span>
          }
        />
        {estateError ? (
          <SettingsRow title="Status" description={describeHomelabError(estateError)} />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function AdvancedSettingsPanel() {
  const showSourceControlUi = shouldShowPrimarySourceControlUi();

  return (
    <SettingsPageContainer>
      <SettingsSection title={HOMELAB_PRODUCT_COPY.settings.advanced}>
        <SettingsRow
          title="Archived threads"
          description="Review and restore archived project threads."
          control={
            <Button render={<Link to="/settings/archived" />} size="xs" variant="outline">
              Open
            </Button>
          }
        />
        <SettingsRow
          title="Keybindings"
          description="Keyboard shortcuts for navigation and thread actions."
          control={
            <Button render={<Link to="/settings/keybindings" />} size="xs" variant="outline">
              Open
            </Button>
          }
        />
        <SettingsRow
          title="Integrations"
          description="Connected tools and agent browser access."
          control={
            <Button render={<Link to="/settings/integrations" />} size="xs" variant="outline">
              Open
            </Button>
          }
        />
        {showSourceControlUi ? (
          <SettingsRow
            title="Source control"
            description="Advanced upstream source-control integration settings."
            control={
              <Button render={<Link to="/settings/source-control" />} size="xs" variant="outline">
                Open
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
