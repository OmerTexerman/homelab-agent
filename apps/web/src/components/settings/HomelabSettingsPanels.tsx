/**
 * Homelab settings pages: Secrets, Project Runtime, Memory & Knowledge and
 * Advanced. Rendered by the fork-owned `routes/settings.*` route files; kept
 * out of the upstream-owned `SettingsPanels.tsx`.
 */
import { useAtomValue } from "@effect/atom-react";
import { LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AuthHomelabCurateScope,
  DEFAULT_MODEL,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";

import { HOSTED_APP_CHANNEL } from "../../branding";
import { connectionAtomRuntime } from "../../connection/runtime";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary/sessionState";
import { describeHomelabError } from "../../homelab/homelabFetch";
import { queryDisplayState } from "../../homelab/queryDisplayState";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  homelabAllMemoryQueryOptions,
  homelabAllSkillsQueryOptions,
  homelabCuratorOverviewQueryOptions,
  homelabSetupStatusQueryOptions,
} from "../../lib/homelabReactQuery";
import { newCommandId, newMessageId, newThreadId } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  HOMELAB_PRODUCT_COPY,
  shouldShowCompatibilityHostPathProjectUi,
  shouldShowPrimarySourceControlUi,
  shouldShowThreadRuntimeIsolationControls,
} from "../../productCapabilities";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerObservabilityAtom, primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { HomelabSecretsSection } from "./HomelabSecretsSection";
import { KnowledgeEstateBrowser } from "./KnowledgeEstateBrowser";
import { RuntimeCliUpdatesSection } from "./RuntimeCliUpdatesSection";
import { AboutVersionSection, AboutVersionTitle, LegacyFeaturesSection } from "./SettingsPanels";
import { formatDiagnosticsDescription } from "./SettingsPanels.logic";
import {
  SettingResetButton,
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
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const showThreadRuntimeIsolationControls = shouldShowThreadRuntimeIsolationControls();

  useEffect(() => {
    if (showThreadRuntimeIsolationControls || settings.defaultThreadEnvMode === "local") {
      return;
    }

    updateSettings({ defaultThreadEnvMode: "local" });
  }, [settings.defaultThreadEnvMode, showThreadRuntimeIsolationControls, updateSettings]);

  return (
    <SettingsPageContainer>
      <RuntimeCliUpdatesSection />
      <SettingsSection title={HOMELAB_PRODUCT_COPY.projectRuntime.title}>
        <SettingsRow
          title={HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeTitle}
          description={HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeDescription}
          resetAction={
            showThreadRuntimeIsolationControls &&
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label={HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeTitle}
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            showThreadRuntimeIsolationControls ? (
              <Select
                value={settings.defaultThreadEnvMode}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree") {
                    updateSettings({ defaultThreadEnvMode: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-64" aria-label="Default Project Runtime">
                  <SelectValue>
                    {settings.defaultThreadEnvMode === "worktree"
                      ? HOMELAB_PRODUCT_COPY.projectRuntime.isolatedRuntimeValue
                      : HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeValue}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="local">
                    {HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeValue}
                  </SelectItem>
                  <SelectItem hideIndicator value="worktree">
                    {HOMELAB_PRODUCT_COPY.projectRuntime.isolatedRuntimeValue}
                  </SelectItem>
                </SelectPopup>
              </Select>
            ) : (
              <span className="inline-flex min-h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground">
                {HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeValue}
              </span>
            )
          }
        />
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
  const sessionState = usePrimarySessionState();
  // Launching/managing curator sessions needs homelab:curate (the scope curator
  // runtimes carry and that gates the /curate/* routes). Gate the launcher UI on
  // it too — optimistic while scopes load, to avoid a disabled-state flash.
  const curateScopes = sessionState.data?.scopes;
  const canCurate = curateScopes === undefined || curateScopes.includes(AuthHomelabCurateScope);
  const { deleteThread } = useThreadActions();
  const dispatchCuratorCommand = useAtomCommand(dispatchHomelabOrchestrationCommand, {
    reportFailure: false,
  });
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const allProjects = useProjects();
  const allSidebarThreads = useThreadShells();
  const [isStartingCuratorSession, setIsStartingCuratorSession] = useState(false);
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
    if (primaryEnvironmentId === null || isStartingCuratorSession) {
      return;
    }
    void (async () => {
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
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(primaryEnvironmentId, threadId)),
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
    })();
  }, [
    curatorModelSelection,
    curatorProject,
    dispatchCuratorCommand,
    isStartingCuratorSession,
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
      enabled: primaryEnvironmentId !== null,
    }),
  );
  const homelabAllSkillsQuery = useQuery(
    homelabAllSkillsQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null,
    }),
  );
  const homelabCuratorOverviewQuery = useQuery(
    homelabCuratorOverviewQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null,
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
            !canCurate ? (
              <span className="text-[11px] text-muted-foreground">
                Requires the <span className="font-medium text-foreground">Curate knowledge</span>{" "}
                permission on this device.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={curatorModelSelection.instanceId}
                  model={curatorModelSelection.model}
                  lockedProvider={null}
                  instanceEntries={curatorInstanceEntries}
                  modelOptionsByInstance={curatorModelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
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
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
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
                  <div className="text-[11px] font-medium text-muted-foreground">
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
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
                        </span>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete "${thread.title}"`}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          // Deleting the session destroys its isolated runtime container and
                          // storage server-side; the sidebar hides curator threads, so this is
                          // the cleanup surface.
                          void deleteThread(scopeThreadRef(thread.environmentId, thread.id));
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
              <div className="mt-2 text-[11px] text-muted-foreground/80">
                {HOMELAB_PRODUCT_COPY.curator.autoCleanupNote}
              </div>
            </>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Knowledge estate"
          description="Everything the homelab durably knows: graph entities, relations, observations, every project's memory, and all skills. Search, filter, and expand any record."
          control={
            homelabCuratorOverviewQuery.data &&
            homelabCuratorOverviewQuery.data.staleEntityCount > 0 ? (
              <span className="inline-flex min-h-8 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-medium text-amber-600 dark:text-amber-400">
                {homelabCuratorOverviewQuery.data.staleEntityCount} stale entities
              </span>
            ) : (
              <span className="inline-flex min-h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground">
                {estateLoading || estateSnapshotState === "loading"
                  ? "Loading"
                  : estateSnapshot
                    ? `Updated ${formatRelativeTimeLabel(estateSnapshot.updatedAt)}`
                    : "Unavailable"}
              </span>
            )
          }
        >
          <div className="mt-3 border-t border-border/60 pt-3">
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
              loading={estateLoading}
            />
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
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const observability = useAtomValue(primaryServerObservabilityAtom);
  const showSourceControlUi = shouldShowPrimarySourceControlUi();
  const showCompatibilityHostPathProjectUi = shouldShowCompatibilityHostPathProjectUi();
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  return (
    <SettingsPageContainer>
      <SettingsSection title={HOMELAB_PRODUCT_COPY.settings.advanced}>
        {showCompatibilityHostPathProjectUi ? (
          <SettingsRow
            title="Compatibility bootstrap path"
            description="Used only by advanced host-path project imports."
            resetAction={
              settings.addProjectBaseDirectory !==
              DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
                <SettingResetButton
                  label="compatibility bootstrap path"
                  onClick={() =>
                    updateSettings({
                      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                className="w-full sm:w-72"
                value={settings.addProjectBaseDirectory}
                onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
                placeholder="~/"
                spellCheck={false}
                aria-label="Compatibility bootstrap path"
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          control={
            <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
              View diagnostics
            </Button>
          }
        />
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

      <SettingsSection title="About">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
      </SettingsSection>

      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}
