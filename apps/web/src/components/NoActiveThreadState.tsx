import {
  BotIcon,
  CheckCircle2Icon,
  ClockIcon,
  DatabaseIcon,
  KeyRoundIcon,
  LoaderIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ProjectRuntimeDetail } from "@t3tools/contracts";
import { isStandaloneProject } from "@t3tools/shared/standaloneProject";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  homelabProjectMemoryQueryOptions,
  homelabSetupStatusQueryOptions,
} from "../lib/homelabReactQuery";
import { useServerProviders } from "../rpc/serverState";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import {
  deriveHomeOverviewReadModel,
  type HomeOverviewMetric,
  type HomeOverviewReadModel,
  type HomeOverviewReadinessItem,
  type HomeOverviewRuntimeRow,
  type HomeOverviewSetupStep,
  type HomeOverviewSeverity,
  type HomeOverviewTopology,
} from "../homeOverviewReadModel";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";

const HOME_RUNTIME_PROJECT_LIMIT = 8;

export function NoActiveThreadState() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providerStatuses = useServerProviders();
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const threads = useStore(useShallow((store) => selectSidebarThreadsAcrossEnvironments(store)));
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();

  const runtimeProjects = useMemo(
    () =>
      projects
        .filter((project) => !isStandaloneProject({ id: project.id, cwd: project.cwd }))
        .slice(0, HOME_RUNTIME_PROJECT_LIMIT),
    [projects],
  );
  const memoryProject = useMemo(
    () =>
      projects.find((project) => !isStandaloneProject({ id: project.id, cwd: project.cwd })) ??
      projects[0] ??
      null,
    [projects],
  );

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
  const projectRuntimeQueries = useQueries({
    queries: runtimeProjects.map((project) => ({
      queryKey: [
        "home-overview",
        "project-runtime",
        project.environmentId,
        project.id,
        project.defaultRuntimeId ?? null,
      ] as const,
      queryFn: async () => {
        const api = readEnvironmentApi(project.environmentId);
        if (!api) {
          throw new Error("Project Runtime API is not available.");
        }
        const result = await api.projectRuntime.get({ projectId: project.id });
        return result.runtime;
      },
      refetchInterval: 5_000,
      refetchOnWindowFocus: true,
      retry: false,
      staleTime: 3_000,
    })),
  });

  const runtimeDetails = runtimeProjects.map((project, index) => ({
    environmentId: project.environmentId,
    projectId: project.id,
    runtimeId: project.defaultRuntimeId ?? null,
    detail: (projectRuntimeQueries[index]?.data as ProjectRuntimeDetail | undefined) ?? null,
  }));
  const model = deriveHomeOverviewReadModel({
    projects,
    threads,
    providers: providerStatuses,
    setupStatus: homelabSetupStatusQuery.data ?? null,
    projectMemoryEntries: projectMemoryQuery.data?.entries ?? [],
    projectRuntimeDetails: runtimeDetails,
  });
  const runtimeQueryError = projectRuntimeQueries.find((query) => query.isError)?.error;
  const errorMessage = [
    homelabSetupStatusQuery.error,
    projectMemoryQuery.error,
    runtimeQueryError,
  ].find((error): error is Error => error instanceof Error)?.message;
  const isRefreshing =
    homelabSetupStatusQuery.isFetching ||
    projectMemoryQuery.isFetching ||
    projectRuntimeQueries.some((query) => query.isFetching);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              {model.title}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
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
          onOpenSettings={() => void navigate({ to: "/settings/general" })}
          onRefresh={() => {
            void homelabSetupStatusQuery.refetch();
            void projectMemoryQuery.refetch();
            for (const query of projectRuntimeQueries) {
              void query.refetch();
            }
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
  readonly onOpenSettings?: () => void;
  readonly onRefresh?: () => void;
}

export function HomeOverviewSurface({
  model,
  isRefreshing = false,
  canCreateThread = true,
  errorMessage = null,
  onNewThread,
  onOpenSettings,
  onRefresh,
}: HomeOverviewSurfaceProps) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-7">
      <div data-testid="home-overview" className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <section className="flex flex-col gap-4 border-b border-border/70 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 max-w-3xl">
            <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              Homelab Agent
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {model.title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{model.subtitle}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button onClick={onNewThread} disabled={!canCreateThread}>
              <BotIcon className="size-4" />
              {model.primaryActionLabel}
            </Button>
            <Button variant="outline" onClick={onOpenSettings}>
              <Settings2Icon className="size-4" />
              {HOMELAB_PRODUCT_COPY.homeOverview.settingsAction}
            </Button>
            <Button variant="ghost" onClick={onRefresh}>
              {isRefreshing ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
              {HOMELAB_PRODUCT_COPY.homeOverview.refreshAction}
            </Button>
          </div>
        </section>

        <section
          aria-label="Home overview metrics"
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
        >
          {model.metrics.map((metric) => (
            <MetricTile key={metric.id} metric={metric} />
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
          <RuntimeWorkSection model={model} />
          <TopologySection topology={model.topology} />
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <ReadinessSection items={model.readiness} />
          <MemorySection model={model} />
          <DecisionsSection model={model} />
        </section>

        {model.setup.incompleteCount > 0 ? <SetupSection model={model} /> : null}

        {errorMessage ? (
          <section className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Status refresh failed. {errorMessage}
          </section>
        ) : null}
      </div>
    </main>
  );
}

function MetricTile({ metric }: { readonly metric: HomeOverviewMetric }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-card/35 px-3 py-3">
      <div className="flex items-center gap-2">
        <SeverityDot severity={metric.severity} />
        <div className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {metric.label}
        </div>
      </div>
      <div className="mt-2 truncate text-2xl font-semibold tracking-tight text-foreground">
        {metric.value}
      </div>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{metric.detail}</p>
    </div>
  );
}

function RuntimeWorkSection({ model }: { readonly model: HomeOverviewReadModel }) {
  const runtime = model.runtime;
  return (
    <section
      data-testid="home-runtime-work"
      className="rounded-lg border border-border/70 bg-card/25"
    >
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ServerIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">
              {HOMELAB_PRODUCT_COPY.homeOverview.runtimeWorkTitle}
            </h2>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Shared Project Runtime work queues on the project; isolated clones run separately.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <SummaryPill icon={<ServerIcon className="size-3.5" />}>
            {runtime.sharedThreadCount} shared
          </SummaryPill>
          <SummaryPill icon={<NetworkIcon className="size-3.5" />}>
            {runtime.isolatedThreadCount} isolated
          </SummaryPill>
          <SummaryPill icon={<ClockIcon className="size-3.5" />}>
            {runtime.queuedWorkCount} queued
          </SummaryPill>
        </div>
      </div>
      {runtime.rows.length > 0 ? (
        <div className="divide-y divide-border/60">
          {runtime.rows.map((row) => (
            <RuntimeRow key={row.id} row={row} />
          ))}
        </div>
      ) : (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          No logical projects are available yet. Create a project to get a default Project Runtime.
        </div>
      )}
    </section>
  );
}

function RuntimeRow({ row }: { readonly row: HomeOverviewRuntimeRow }) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <SeverityDot severity={row.severity} />
          <span className="truncate text-sm font-medium text-foreground">{row.projectName}</span>
          <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {row.statusLabel}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {row.runtimeId ?? "Project Runtime not created yet"}
        </div>
        {row.latestThreadTitle ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            Latest thread: {row.latestThreadTitle}
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4 md:min-w-[21rem]">
        <RuntimeCell label="Queue" value={row.queueSummary} />
        <RuntimeCell label="Shared" value={String(row.sharedThreadCount)} />
        <RuntimeCell label="Isolated" value={String(row.isolatedThreadCount)} />
        <RuntimeCell label="Waiting" value={String(row.waitingThreadCount)} />
      </div>
    </div>
  );
}

function RuntimeCell(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
        {props.label}
      </div>
      <div className="mt-1 truncate text-xs font-medium text-foreground">{props.value}</div>
    </div>
  );
}

function TopologySection({ topology }: { readonly topology: HomeOverviewTopology }) {
  return (
    <section data-testid="home-topology" className="rounded-lg border border-border/70 bg-card/25">
      <div className="border-b border-border/70 px-4 py-4">
        <div className="flex items-center gap-2">
          <NetworkIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            {HOMELAB_PRODUCT_COPY.homeOverview.topologyTitle}
          </h2>
        </div>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Promoted hosts, services, endpoints, and relations.
        </p>
      </div>
      {topology.hasGraphData ? (
        <div className="p-4">
          <TopologyGraph topology={topology} />
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <SummaryPill icon={<ServerIcon className="size-3.5" />}>
              {topology.nodes.length} shown
            </SummaryPill>
            <SummaryPill icon={<NetworkIcon className="size-3.5" />}>
              {topology.edges.length} relations
            </SummaryPill>
            {topology.kindGroups.map((group) => (
              <SummaryPill key={`kind:${group.label}`}>
                {group.label} {group.count}
              </SummaryPill>
            ))}
            {topology.statusGroups.map((group) => (
              <SummaryPill key={`status:${group.label}`}>
                {group.label} {group.count}
              </SummaryPill>
            ))}
            {topology.omittedEntityCount > 0 || topology.omittedRelationCount > 0 ? (
              <SummaryPill>
                {topology.omittedEntityCount} entities, {topology.omittedRelationCount} relations
                omitted
              </SummaryPill>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="p-4">
          <div className="rounded-lg border border-dashed border-border/80 px-4 py-7 text-sm text-muted-foreground">
            <div className="font-medium text-foreground">{topology.emptyTitle}</div>
            <p className="mt-2 leading-5">{topology.emptyDescription}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function TopologyGraph({ topology }: { readonly topology: HomeOverviewTopology }) {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node] as const));
  return (
    <svg
      role="img"
      aria-label="Homelab topology graph"
      viewBox="0 0 100 100"
      className="h-64 w-full rounded-lg border border-border/70 bg-background/40"
    >
      <defs>
        <marker
          id="home-topology-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/50" />
        </marker>
      </defs>
      {topology.edges.map((edge) => {
        const from = nodeById.get(edge.fromId);
        const to = nodeById.get(edge.toId);
        if (!from || !to) {
          return null;
        }
        return (
          <line
            key={edge.id}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            className="stroke-border"
            strokeWidth="0.65"
            markerEnd="url(#home-topology-arrow)"
          />
        );
      })}
      {topology.nodes.map((node) => (
        <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
          <circle
            r="5.4"
            className={cn(
              "stroke-border",
              node.status === "active"
                ? "fill-success/20"
                : node.status === "deprecated"
                  ? "fill-destructive/15"
                  : "fill-muted",
            )}
            strokeWidth="0.7"
          />
          <text y="10" textAnchor="middle" className="fill-foreground text-[3.2px] font-medium">
            {truncateSvgLabel(node.label)}
          </text>
          <text y="14" textAnchor="middle" className="fill-muted-foreground text-[2.6px]">
            {node.kind.replaceAll("_", " ")}
          </text>
        </g>
      ))}
    </svg>
  );
}

function ReadinessSection({ items }: { readonly items: readonly HomeOverviewReadinessItem[] }) {
  return (
    <section className="rounded-lg border border-border/70 bg-card/25">
      <SectionHeader
        icon={<ShieldCheckIcon className="size-4 text-muted-foreground" />}
        title={HOMELAB_PRODUCT_COPY.homeOverview.readinessTitle}
      />
      <div className="divide-y divide-border/60">
        {items.map((item) => (
          <ReadinessRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function ReadinessRow({ item }: { readonly item: HomeOverviewReadinessItem }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <SeverityDot severity={item.severity} />
          <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>
      </div>
      <div className="text-sm font-semibold text-foreground">{item.value}</div>
    </div>
  );
}

function MemorySection({ model }: { readonly model: HomeOverviewReadModel }) {
  const memory = model.memory;
  return (
    <section className="rounded-lg border border-border/70 bg-card/25">
      <SectionHeader
        icon={<DatabaseIcon className="size-4 text-muted-foreground" />}
        title={HOMELAB_PRODUCT_COPY.homeOverview.memoryTitle}
      />
      <div className="grid grid-cols-2 gap-0 border-b border-border/70">
        <MemoryStat label="Project memory" value={memory.projectMemoryCount} />
        <MemoryStat label="Global entities" value={memory.globalEntityCount} />
        <MemoryStat label="Promoted" value={memory.promotedProjectMemoryCount} />
        <MemoryStat label="Relations" value={memory.globalRelationCount} />
      </div>
      <div className="px-4 py-3">
        {memory.recentEntities.length > 0 ? (
          <div className="space-y-2">
            {memory.recentEntities.slice(0, 3).map((entity) => (
              <div key={entity.id} className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{entity.label}</div>
                <div className="mt-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">
                  {entity.kind.replaceAll("_", " ")} - {entity.status}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm leading-5 text-muted-foreground">
            Project memory and promoted homelab knowledge will appear here after threads record
            discoveries.
          </p>
        )}
      </div>
    </section>
  );
}

function DecisionsSection({ model }: { readonly model: HomeOverviewReadModel }) {
  const decisions = model.decisions;
  return (
    <section className="rounded-lg border border-border/70 bg-card/25">
      <SectionHeader
        icon={<ShieldAlertIcon className="size-4 text-muted-foreground" />}
        title={HOMELAB_PRODUCT_COPY.homeOverview.decisionsTitle}
        value={String(decisions.totalCount)}
      />
      {decisions.items.length > 0 ? (
        <div className="divide-y divide-border/60">
          {decisions.items.map((item) => (
            <div key={item.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <SeverityDot severity={item.severity} />
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {item.label}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-8 text-sm leading-5 text-muted-foreground">
          No approvals, user-input prompts, or plan reviews are waiting.
        </div>
      )}
    </section>
  );
}

function SetupSection({ model }: { readonly model: HomeOverviewReadModel }) {
  return (
    <section className="rounded-lg border border-border/70 bg-card/25">
      <div className="grid gap-4 px-4 py-4 lg:grid-cols-[18rem_1fr] lg:items-start">
        <div>
          <div className="flex items-center gap-2">
            {model.setup.incompleteCount === 0 ? (
              <CheckCircle2Icon className="size-4 text-success" />
            ) : (
              <KeyRoundIcon className="size-4 text-muted-foreground" />
            )}
            <h2 className="text-sm font-semibold text-foreground">{model.setup.title}</h2>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{model.setup.description}</p>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {model.setup.steps.map((step) => (
            <SetupStep key={step.id} step={step} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SetupStep({ step }: { readonly step: HomeOverviewSetupStep }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 px-3 py-3">
      <div className="flex items-center gap-2">
        {step.complete ? (
          <CheckCircle2Icon className="size-4 shrink-0 text-success" />
        ) : (
          <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="truncate text-sm font-medium text-foreground">{step.label}</div>
      </div>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{step.detail}</p>
    </div>
  );
}

function SectionHeader(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly value?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-4">
      <div className="flex min-w-0 items-center gap-2">
        {props.icon}
        <h2 className="truncate text-sm font-semibold text-foreground">{props.title}</h2>
      </div>
      {props.value ? (
        <span className="text-sm font-semibold text-foreground">{props.value}</span>
      ) : null}
    </div>
  );
}

function MemoryStat(props: { readonly label: string; readonly value: number }) {
  return (
    <div className="border-r border-b border-border/60 px-4 py-3 even:border-r-0">
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {props.label}
      </div>
      <div className="mt-1 text-lg font-semibold text-foreground">{props.value}</div>
    </div>
  );
}

function SummaryPill(props: { readonly icon?: ReactNode; readonly children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-border/70 px-2 py-1">
      {props.icon}
      <span className="truncate">{props.children}</span>
    </span>
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

function truncateSvgLabel(label: string): string {
  return label.length > 16 ? `${label.slice(0, 15)}...` : label;
}
