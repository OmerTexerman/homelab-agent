import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { isCuratorProject } from "@t3tools/shared/curatorProject";
import { isStandaloneProject } from "@t3tools/shared/standaloneProject";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  homelabProjectMemoryQueryOptions,
  homelabSetupStatusQueryOptions,
} from "../lib/homelabReactQuery";
import {
  deriveHomeOverviewReadModel,
  type HomeOverviewAttentionItem,
  type HomeOverviewReadModel,
  type HomeOverviewReadinessItem,
  type HomeOverviewRecentThread,
  type HomeOverviewRuntimeRow,
  type HomeOverviewSeverity,
  type HomeOverviewThreadRef,
} from "../homeOverviewReadModel";
import { useProjects, useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";

const HOME_RUNTIME_PROJECT_LIMIT = 8;

export function NoActiveThreadState() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providerStatuses = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects();
  const threads = useThreadShells();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();

  const runtimeProjects = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            !isStandaloneProject({ id: project.id, workspaceRoot: project.workspaceRoot }) &&
            !isCuratorProject({ id: project.id, workspaceRoot: project.workspaceRoot }),
        )
        .slice(0, HOME_RUNTIME_PROJECT_LIMIT),
    [projects],
  );
  const memoryProject = useMemo(() => runtimeProjects[0] ?? null, [runtimeProjects]);

  const homelabSetupStatusQuery = useQuery(
    homelabSetupStatusQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null,
    }),
  );
  const projectMemoryQuery = useQuery(
    homelabProjectMemoryQueryOptions({
      environmentId: memoryProject?.environmentId ?? null,
      projectId: memoryProject?.id ?? null,
      enabled: memoryProject !== null,
      limit: 50,
    }),
  );
  // NOTE: live Project Runtime detail polling relied on the per-environment ws
  // RPC client (`environmentApi`) that was removed in the upstream client-runtime
  // refactor. Until projectRuntime atoms exist in @t3tools/client-runtime, the
  // overview derives runtime rows from projects/threads alone (detail: null).
  const runtimeDetails = runtimeProjects.map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
    runtimeId: project.defaultRuntimeId ?? null,
    detail: null,
  }));
  const model = deriveHomeOverviewReadModel({
    projects,
    threads,
    providers: providerStatuses,
    setupStatus: homelabSetupStatusQuery.data ?? null,
    projectMemoryEntries: projectMemoryQuery.data?.entries ?? [],
    projectRuntimeDetails: runtimeDetails,
  });
  const errorMessage = [homelabSetupStatusQuery.error, projectMemoryQuery.error].find(
    (error): error is Error => error instanceof Error,
  )?.message;
  const isRefreshing = homelabSetupStatusQuery.isFetching || projectMemoryQuery.isFetching;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[var(--workspace-native-controls-inset)]">
              {model.title}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                {model.title}
              </span>
            </div>
          )}
        </header>

        <HomeOverviewSurface
          model={model}
          isRefreshing={isRefreshing}
          canCreateThread={defaultProjectRef !== null}
          errorMessage={errorMessage ?? null}
          onNewThread={() => {
            if (!defaultProjectRef) {
              return;
            }
            void handleNewThread(defaultProjectRef, { runtimeSelectionMode: "shared" });
          }}
          onOpenThread={(ref) => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: ref.environmentId, threadId: ref.threadId },
            });
          }}
          onOpenKnowledge={() => void navigate({ to: "/settings/memory" })}
          onOpenSettings={() => void navigate({ to: "/settings/general" })}
          onRefresh={() => {
            void homelabSetupStatusQuery.refetch();
            void projectMemoryQuery.refetch();
          }}
        />
      </div>
    </SidebarInset>
  );
}

export interface HomeOverviewSurfaceProps {
  readonly model: HomeOverviewReadModel;
  readonly isRefreshing?: boolean;
  readonly canCreateThread?: boolean;
  readonly errorMessage?: string | null;
  readonly onNewThread?: () => void;
  readonly onOpenThread?: (ref: HomeOverviewThreadRef) => void;
  readonly onOpenKnowledge?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onRefresh?: () => void;
}

export function HomeOverviewSurface({
  model,
  isRefreshing = false,
  canCreateThread = true,
  errorMessage = null,
  onNewThread,
  onOpenThread,
  onOpenKnowledge,
  onOpenSettings,
  onRefresh,
}: HomeOverviewSurfaceProps) {
  const copy = HOMELAB_PRODUCT_COPY.homeOverview;
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div
        data-testid="home-overview"
        className="mx-auto flex w-full max-w-5xl flex-col gap-9 px-4 py-7 sm:px-6 sm:py-10"
      >
        <section className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="min-w-0 max-w-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {model.title}
              </h1>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{model.subtitle}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={onNewThread} disabled={!canCreateThread}>
                <PlusIcon className="size-4" />
                {model.primaryActionLabel}
              </Button>
              <Button variant="outline" onClick={onOpenSettings}>
                <Settings2Icon className="size-4" />
                {copy.settingsAction}
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-y border-border/60 py-2.5 text-sm">
            <SeverityDot severity={model.health.severity} />
            <span className="font-medium text-foreground">{model.health.headline}</span>
            {model.facts.map((fact) => (
              <span
                key={fact.id}
                className="flex items-center gap-x-2.5 whitespace-nowrap text-muted-foreground"
              >
                <span aria-hidden="true" className="text-border">
                  /
                </span>
                <span>
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      fact.severity === "attention" ? "text-destructive" : "text-foreground/85",
                    )}
                  >
                    {fact.value}
                  </span>{" "}
                  {fact.label}
                </span>
              </span>
            ))}
            <button
              type="button"
              onClick={onRefresh}
              aria-label={copy.refreshAction}
              className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {isRefreshing ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
            </button>
          </div>
        </section>

        {model.attention.items.length > 0 ? (
          <AttentionSection items={model.attention.items} onOpenThread={onOpenThread} />
        ) : null}

        {model.setup.incompleteCount > 0 ? <SetupSection model={model} /> : null}

        <div className="grid gap-x-10 gap-y-9 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <ActivitySection
            threads={model.recentThreads}
            canCreateThread={canCreateThread}
            primaryActionLabel={model.primaryActionLabel}
            onNewThread={onNewThread}
            onOpenThread={onOpenThread}
          />
          <aside className="flex min-w-0 flex-col gap-9 lg:border-l lg:border-border/50 lg:pl-8">
            <RuntimesSection rows={model.runtime.rows} />
            <ReadinessSection items={model.readiness} />
            <KnowledgeSection model={model} onOpenKnowledge={onOpenKnowledge} />
          </aside>
        </div>

        {errorMessage ? (
          <section className="border-l-2 border-destructive py-1 pl-3 text-sm text-destructive">
            Status refresh failed. {errorMessage}
          </section>
        ) : null}
      </div>
    </main>
  );
}

function AttentionSection(props: {
  readonly items: readonly HomeOverviewAttentionItem[];
  readonly onOpenThread?: ((ref: HomeOverviewThreadRef) => void) | undefined;
}) {
  return (
    <section data-testid="home-attention" className="flex flex-col gap-1">
      <SectionLabel count={props.items.length}>
        {HOMELAB_PRODUCT_COPY.homeOverview.attentionTitle}
      </SectionLabel>
      <div className="divide-y divide-border/50">
        {props.items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() =>
              props.onOpenThread?.({ environmentId: item.environmentId, threadId: item.threadId })
            }
            className="group flex w-full items-center gap-3 py-2.5 text-left"
          >
            <SeverityDot severity={item.severity} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground underline-offset-4 group-hover:underline">
              {item.title}
            </span>
            <span
              className={cn(
                "shrink-0 text-xs",
                item.severity === "attention" ? "text-destructive" : "text-warning-foreground",
              )}
            >
              {item.reason}
            </span>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {formatRelativeTimeLabel(item.timestamp)}
            </span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </section>
  );
}

function ActivitySection(props: {
  readonly threads: readonly HomeOverviewRecentThread[];
  readonly canCreateThread: boolean;
  readonly primaryActionLabel: string;
  readonly onNewThread?: (() => void) | undefined;
  readonly onOpenThread?: ((ref: HomeOverviewThreadRef) => void) | undefined;
}) {
  const copy = HOMELAB_PRODUCT_COPY.homeOverview;
  return (
    <section data-testid="home-activity" className="flex min-w-0 flex-col gap-2">
      <SectionLabel>{copy.activityTitle}</SectionLabel>
      {props.threads.length > 0 ? (
        <div className="flex flex-col">
          {props.threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() =>
                props.onOpenThread?.({
                  environmentId: thread.environmentId,
                  threadId: thread.threadId,
                })
              }
              className="group -mx-2 flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted/50"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  thread.isRunning
                    ? "animate-pulse bg-success"
                    : thread.pendingReason
                      ? "bg-warning"
                      : "bg-muted-foreground/30",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {thread.title}
                </span>
                <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-[11px] text-muted-foreground">
                  <span className="shrink-0 font-mono uppercase tracking-wider">
                    {thread.contextLabel}
                  </span>
                  {thread.isIsolated ? (
                    <span className="shrink-0 font-mono uppercase tracking-wider">isolated</span>
                  ) : null}
                  {thread.pendingReason ? (
                    <span className="truncate text-warning-foreground">{thread.pendingReason}</span>
                  ) : thread.isRunning ? (
                    <span className="truncate text-success-foreground">Working</span>
                  ) : null}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatRelativeTimeLabel(thread.timestamp)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border/80 px-5 py-8">
          <div className="text-sm font-medium text-foreground">{copy.activityEmptyTitle}</div>
          <p className="mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">
            {copy.activityEmptyDescription}
          </p>
          <Button
            className="mt-4"
            size="sm"
            onClick={props.onNewThread}
            disabled={!props.canCreateThread}
          >
            <PlusIcon className="size-4" />
            {props.primaryActionLabel}
          </Button>
        </div>
      )}
    </section>
  );
}

function RuntimesSection({ rows }: { readonly rows: readonly HomeOverviewRuntimeRow[] }) {
  const copy = HOMELAB_PRODUCT_COPY.homeOverview;
  return (
    <section data-testid="home-runtimes" className="flex flex-col gap-2">
      <SectionLabel>{copy.runtimesTitle}</SectionLabel>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <div key={row.id} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <SeverityDot severity={row.severity} />
                  <span className="truncate text-sm font-medium text-foreground">
                    {row.projectName}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {row.statusLabel}
                </span>
              </div>
              <div className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
                {runtimeRowSummary(row)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">{copy.runtimesEmptyDescription}</p>
      )}
    </section>
  );
}

function runtimeRowSummary(row: HomeOverviewRuntimeRow): string {
  const parts = [row.queueSummary];
  const threadCount = row.sharedThreadCount + row.isolatedThreadCount;
  if (threadCount > 0) {
    parts.push(`${threadCount} ${threadCount === 1 ? "thread" : "threads"}`);
  }
  if (row.isolatedThreadCount > 0) {
    parts.push(`${row.isolatedThreadCount} isolated`);
  }
  return parts.join(" · ");
}

function ReadinessSection({ items }: { readonly items: readonly HomeOverviewReadinessItem[] }) {
  return (
    <section data-testid="home-readiness" className="flex flex-col gap-2">
      <SectionLabel>{HOMELAB_PRODUCT_COPY.homeOverview.readinessTitle}</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {items.map((item) => (
          <div key={item.id} className="min-w-0">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <SeverityDot severity={item.severity} />
                <span className="truncate text-muted-foreground">{item.label}</span>
              </span>
              <span className="shrink-0 font-medium tabular-nums text-foreground">
                {item.value}
              </span>
            </div>
            {item.severity === "attention" || item.severity === "partial" ? (
              <p className="mt-0.5 pl-4 text-xs leading-5 text-muted-foreground">{item.detail}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function KnowledgeSection(props: {
  readonly model: HomeOverviewReadModel;
  readonly onOpenKnowledge?: (() => void) | undefined;
}) {
  const copy = HOMELAB_PRODUCT_COPY.homeOverview;
  const knowledge = props.model.knowledge;
  return (
    <section data-testid="home-knowledge" className="flex flex-col gap-2">
      <SectionLabel>{copy.knowledgeTitle}</SectionLabel>
      {knowledge.entityCount > 0 ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">
              {knowledge.entityCount}
            </span>{" "}
            {knowledge.entityCount === 1 ? "entity" : "entities"} ·{" "}
            <span className="font-medium tabular-nums text-foreground">
              {knowledge.relationCount}
            </span>{" "}
            {knowledge.relationCount === 1 ? "relation" : "relations"}
          </p>
          {knowledge.kindGroups.length > 0 ? (
            <p className="font-mono text-[11px] leading-5 text-muted-foreground">
              {knowledge.kindGroups.map((group) => `${group.label} ${group.count}`).join(" · ")}
            </p>
          ) : null}
          {knowledge.projectMemoryCount > 0 ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {knowledge.promotedProjectMemoryCount} promoted ·{" "}
              {knowledge.proposedProjectMemoryCount} proposed project memories
            </p>
          ) : null}
          {knowledge.recentEntities.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border/40 border-y border-border/40">
              {knowledge.recentEntities.map((entity) => (
                <li
                  key={entity.id}
                  className="flex items-baseline justify-between gap-2 py-1.5 text-xs"
                >
                  <span className="truncate text-foreground">{entity.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {entity.kind.replaceAll("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            onClick={props.onOpenKnowledge}
            className="group inline-flex items-center gap-1 self-start text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            {copy.knowledgeGraphAction}
            <ArrowUpRightIcon className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </button>
        </div>
      ) : (
        <div>
          <div className="text-sm font-medium text-foreground">{knowledge.emptyTitle}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {knowledge.emptyDescription}
          </p>
        </div>
      )}
    </section>
  );
}

function SetupSection({ model }: { readonly model: HomeOverviewReadModel }) {
  return (
    <section data-testid="home-setup" className="flex flex-col gap-1">
      <SectionLabel count={model.setup.incompleteCount}>{model.setup.title}</SectionLabel>
      <ol className="divide-y divide-border/50">
        {model.setup.steps.map((step, index) => (
          <li key={step.id} className="flex gap-4 py-3">
            <span className="w-5 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{step.label}</div>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SectionLabel(props: { readonly children: ReactNode; readonly count?: number }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="shrink-0 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {props.children}
      </h2>
      {props.count !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
          {props.count}
        </span>
      ) : null}
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border/60" />
    </div>
  );
}

function SeverityDot({ severity }: { readonly severity: HomeOverviewSeverity }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", severityClass(severity))}
    />
  );
}

function severityClass(severity: HomeOverviewSeverity): string {
  switch (severity) {
    case "good":
      return "bg-success";
    case "partial":
      return "bg-warning";
    case "attention":
      return "bg-destructive";
    case "neutral":
      return "bg-muted-foreground/50";
  }
}
