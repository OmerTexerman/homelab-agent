import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Settings2Icon, SquarePenIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { isElectron } from "../../env";
import {
  EGRESS_AUDIT_DECISION_BADGE,
  EGRESS_AUDIT_DECISION_LABEL,
  EGRESS_AUDIT_LIMIT,
  describeEgressTarget,
} from "../../homelab/egressBroker";
import {
  homeProjectKey,
  homeProjectsInDisplayOrder,
  type HomeRuntimeDetailState,
} from "../../homelab/homeOverview";
import { homelabProjectDisplayTitle } from "../../homelab/projectDisplayTitle";
import {
  deriveProjectPageOverview,
  projectPageEgressActivity,
  projectPageMemoryEntries,
  projectPageRuntimeTools,
  projectPageSecrets,
  resolveProjectPageGroup,
  runtimeToolInstallSummary,
} from "../../homelab/projectPage";
import { queryDisplayState, type QueryDisplayState } from "../../homelab/queryDisplayState";
import { useUserVisibleProjects, useUserVisibleThreadShells } from "../../homelab/visibleProjects";
import {
  homelabEgressApprovalsQueryOptions,
  homelabEgressAuditQueryOptions,
} from "../../lib/homelabEgressReactQuery";
import { homelabProjectMemoryQueryOptions } from "../../lib/homelabReactQuery";
import { homelabRuntimeToolsQueryOptions } from "../../lib/homelabRuntimeToolsReactQuery";
import { homelabSecretsQueryOptions } from "../../lib/homelabSecretsReactQuery";
import { projectRuntimeDetailQueryOptions } from "../../lib/projectRuntimeReactQuery";
import { cn } from "../../lib/utils";
import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectRuntimePanel } from "../ProjectRuntimePanel";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  AttentionRow,
  HomeLoadingRows,
  HomeSectionFrame,
  HomeStartPrompt,
  Placeholder,
  RUNTIME_DOT,
  StatusDot,
  ThreadRow,
  combineRuntimeStates,
  useStartThreadIn,
} from "./HomelabHomeOverview";

const copy = HOMELAB_PRODUCT_COPY.projectPage;
const homeCopy = HOMELAB_PRODUCT_COPY.homeOverview;

type ExpandableSection = "attention" | "running" | "threads";

/**
 * A project's page (`/projects/$projectKey`): its runtime and controls, a
 * prompt that starts a thread in it, what needs the user, its threads, and
 * what its runtime carries (memory, secrets, tools, egress activity).
 *
 * The key is the logical project key the sidebar and command palette link
 * with. Unknown keys and the hidden namespaces render as not found.
 */
export function HomelabProjectPage() {
  const { projectKey } = useParams({ from: "/projects/$projectKey" });
  const groups = useSettingsProjectGroups();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const group = useMemo(() => resolveProjectPageGroup(groups, projectKey), [groups, projectKey]);

  if (group === null) {
    return (
      <ProjectPageShell title={bootstrapped ? copy.notFoundTitle : ""}>
        {bootstrapped ? <ProjectNotFound /> : <HomeLoadingRows />}
      </ProjectPageShell>
    );
  }
  return <ProjectPageContent key={group.projectKey} group={group} />;
}

function ProjectPageShell({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="min-w-0 truncate text-sm font-medium text-foreground md:text-muted-foreground/60">
            {title}
          </span>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div
            data-testid="project-page"
            className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10"
          >
            {children}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

function ProjectNotFound() {
  return (
    <Empty data-testid="project-not-found">
      <EmptyHeader>
        <EmptyTitle>{copy.notFoundTitle}</EmptyTitle>
        <EmptyDescription>{copy.notFoundDescription}</EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" size="sm" render={<Link to="/" />}>
        {copy.notFoundHomeAction}
      </Button>
    </Empty>
  );
}

function ProjectPageContent({ group }: { readonly group: SidebarProjectSnapshot }) {
  const projects = useUserVisibleProjects();
  const threads = useUserVisibleThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const startThreadIn = useStartThreadIn();
  const [expanded, setExpanded] = useState<ReadonlySet<ExpandableSection>>(() => new Set());
  const members = group.memberProjects;
  const title = homelabProjectDisplayTitle(group, group.displayName);
  // The representative member: the runtime the controls act on and the memory shown.
  const primary = group;
  const projectRef = scopeProjectRef(primary.environmentId, primary.id);

  // Same query keys (and polling) as Home's project rows.
  const runtimeStates = useQueries({
    queries: members.map((member) =>
      projectRuntimeDetailQueryOptions({
        environmentId: member.environmentId,
        projectId: member.id,
        runtimeId: member.defaultRuntimeId ?? null,
      }),
    ),
    combine: combineRuntimeStates,
  });
  const runtimeDetails = useMemo(() => {
    const details = new Map<string, HomeRuntimeDetailState>();
    members.forEach((member, index) => {
      details.set(
        homeProjectKey({ environmentId: member.environmentId, projectId: member.id }),
        runtimeStates[index] ?? { status: "loading" },
      );
    });
    return details;
  }, [members, runtimeStates]);

  const secretsQuery = useQuery(
    homelabSecretsQueryOptions({ environmentId: primaryEnvironmentId }),
  );
  const egressApprovalsQuery = useQuery(
    homelabEgressApprovalsQueryOptions({ environmentId: primaryEnvironmentId }),
  );

  const secretsData = secretsQuery.data;
  const secretsStatus = secretsQuery.status;
  const egressData = egressApprovalsQuery.data;
  const egressStatus = egressApprovalsQuery.status;
  const model = useMemo(
    () =>
      deriveProjectPageOverview({
        bootstrapped,
        members,
        threads,
        runtimeDetails,
        secrets:
          primaryEnvironmentId === null
            ? null
            : {
                environmentId: primaryEnvironmentId,
                state: queryDisplayState({ status: secretsStatus, data: secretsData }, (data) =>
                  data.secrets.every((secret) => !secret.pending),
                ),
                secrets: secretsData?.secrets ?? [],
              },
        egressApprovals:
          primaryEnvironmentId === null
            ? null
            : {
                environmentId: primaryEnvironmentId,
                state: queryDisplayState(
                  { status: egressStatus, data: egressData },
                  (data) => data.approvals.length === 0,
                ),
                approvals: egressData?.approvals ?? [],
              },
        limits: {
          attention: expanded.has("attention") ? Infinity : undefined,
          running: expanded.has("running") ? Infinity : undefined,
          threads: expanded.has("threads") ? Infinity : undefined,
        },
      }),
    [
      bootstrapped,
      egressData,
      egressStatus,
      expanded,
      members,
      primaryEnvironmentId,
      runtimeDetails,
      secretsData,
      secretsStatus,
      threads,
    ],
  );

  const toggle = useCallback((section: ExpandableSection) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const startOptions = useMemo(
    () => homeProjectsInDisplayOrder(projects, threads),
    [projects, threads],
  );
  // Secrets, tools, and egress are read from the primary environment only.
  const primaryEnvironmentProjectIds = useMemo(
    () =>
      new Set<string>(
        members
          .filter((member) => member.environmentId === primaryEnvironmentId)
          .map((member) => member.id),
      ),
    [members, primaryEnvironmentId],
  );
  const primaryEnvironmentThreadIds = useMemo(
    () =>
      new Set<string>(
        threads
          .filter(
            (thread) =>
              thread.environmentId === primaryEnvironmentId &&
              primaryEnvironmentProjectIds.has(thread.projectId),
          )
          .map((thread) => thread.id),
      ),
    [primaryEnvironmentId, primaryEnvironmentProjectIds, threads],
  );
  const runtimeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const member of members) {
      if (member.environmentId !== primaryEnvironmentId) continue;
      if (member.defaultRuntimeId) ids.add(member.defaultRuntimeId);
    }
    for (const state of runtimeStates) {
      if (state.status === "ready") ids.add(state.detail.runtime.id);
    }
    return ids;
  }, [members, primaryEnvironmentId, runtimeStates]);

  const projectSecrets = useMemo(
    () => projectPageSecrets(secretsData?.secrets ?? [], primaryEnvironmentProjectIds),
    [primaryEnvironmentProjectIds, secretsData],
  );

  const runtime = model.runtime;
  const runtimeTone = runtime?.runtimeTone ?? "unknown";

  return (
    <ProjectPageShell title={title}>
      <header data-testid="project-header" className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <StatusDot className={RUNTIME_DOT[runtimeTone]} />
          <h1 className="min-w-0 truncate text-lg font-semibold text-foreground">{title}</h1>
          {runtime === null || runtime.runtimeStatus === "loading" ? (
            <Placeholder className="h-3 w-14" />
          ) : runtime.runtimeStatus === "ready" ? (
            <span
              className={cn(
                "font-mono text-3xs uppercase tracking-wider",
                runtimeTone === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {runtime.runtimeLabel}
            </span>
          ) : null}
          <span aria-hidden="true" className="flex-1" />
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void startThreadIn(projectRef)}>
              <SquarePenIcon className="size-4" />
              {copy.newThreadAction}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              render={
                <Link
                  to="/settings/projects"
                  search={{ project: group.projectKey, machine: undefined }}
                />
              }
            >
              <Settings2Icon className="size-4" />
              {copy.settingsAction}
            </Button>
          </div>
        </div>
        <ProjectRuntimePanel
          environmentId={primary.environmentId}
          projectId={primary.id}
          threadId={null}
          runtimeId={primary.defaultRuntimeId ?? null}
          className="rounded-xl border border-border"
        />
      </header>

      <HomeStartPrompt
        projects={startOptions}
        startThreadIn={startThreadIn}
        showScratchAction={false}
        defaultProjectKey={homeProjectKey({
          environmentId: primary.environmentId,
          projectId: primary.id,
        })}
      />

      {model.status === "loading" ? (
        <HomeLoadingRows />
      ) : (
        <>
          <HomeSectionFrame
            testId="project-attention"
            title={homeCopy.attentionTitle}
            total={model.attention.total}
            shown={model.attention.items.length}
            expanded={expanded.has("attention")}
            onToggle={() => toggle("attention")}
          >
            {model.attention.items.length > 0 ? (
              model.attention.items.map((item) => (
                <AttentionRow key={item.id} item={item} startThreadIn={startThreadIn} />
              ))
            ) : (
              <SectionNote>
                {model.attention.complete ? homeCopy.attentionEmpty : homeCopy.attentionChecking}
              </SectionNote>
            )}
          </HomeSectionFrame>

          {model.running.total > 0 ? (
            <HomeSectionFrame
              testId="project-running"
              title={homeCopy.runningTitle}
              total={model.running.total}
              shown={model.running.items.length}
              expanded={expanded.has("running")}
              onToggle={() => toggle("running")}
            >
              {model.running.items.map((row) => (
                <ThreadRow key={row.id} row={row} />
              ))}
            </HomeSectionFrame>
          ) : null}

          <HomeSectionFrame
            testId="project-threads"
            title={copy.threadsTitle}
            total={model.threads.total}
            shown={model.threads.items.length}
            expanded={expanded.has("threads")}
            onToggle={() => toggle("threads")}
          >
            {model.threads.items.length > 0 ? (
              model.threads.items.map((row) => <ThreadRow key={row.id} row={row} />)
            ) : (
              <SectionNote>{copy.threadsEmpty}</SectionNote>
            )}
          </HomeSectionFrame>
        </>
      )}

      <ProjectMemorySection
        environmentId={primary.environmentId}
        projectId={primary.id}
        projectKey={group.projectKey}
      />
      {primaryEnvironmentId !== null && primaryEnvironmentProjectIds.size > 0 ? (
        <>
          <ProjectSecretsSection
            secretsState={queryDisplayState(secretsQuery, () => projectSecrets.length === 0)}
            secrets={projectSecrets}
          />
          <ProjectRuntimeToolsSection
            environmentId={primaryEnvironmentId}
            projectIds={primaryEnvironmentProjectIds}
          />
          <ProjectEgressSection
            environmentId={primaryEnvironmentId}
            runtimeIds={runtimeIds}
            threadIds={primaryEnvironmentThreadIds}
          />
        </>
      ) : null}
    </ProjectPageShell>
  );
}

function SectionNote({
  children,
  tone = "muted",
}: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "error";
}) {
  return (
    <p
      className={cn(
        "py-2 text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

function SectionLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 py-2">
      <span className="sr-only">Loading</span>
      {[0, 1].map((index) => (
        <div key={index} className="flex items-center gap-3">
          <Placeholder className="h-4 flex-1" />
          <Placeholder className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

/** Renders a section's loading, error, and empty states; `children` only once there are rows. */
function SectionBody({
  state,
  empty,
  error,
  children,
}: {
  readonly state: QueryDisplayState;
  readonly empty: string;
  readonly error: string;
  readonly children: ReactNode;
}) {
  if (state === "loading") return <SectionLoading />;
  if (state === "error") return <SectionNote tone="error">{error}</SectionNote>;
  if (state === "empty") return <SectionNote>{empty}</SectionNote>;
  return <>{children}</>;
}

function SectionLink({
  children,
  link,
}: {
  readonly children: ReactNode;
  readonly link: ReactElement;
}) {
  return (
    <Button variant="ghost" size="compact" render={link}>
      {children}
    </Button>
  );
}

function ProjectMemorySection(props: {
  readonly environmentId: SidebarProjectSnapshot["environmentId"];
  readonly projectId: SidebarProjectSnapshot["id"];
  readonly projectKey: string;
}) {
  const memoryQuery = useQuery(
    homelabProjectMemoryQueryOptions({
      environmentId: props.environmentId,
      projectId: props.projectId,
    }),
  );
  const state = queryDisplayState(memoryQuery, (data) => data.entries.length === 0);
  const total = memoryQuery.data?.entries.length ?? 0;
  const entries = useMemo(
    () => projectPageMemoryEntries(memoryQuery.data?.entries ?? []),
    [memoryQuery.data],
  );
  return (
    <HomeSectionFrame
      testId="project-memory"
      title={copy.memoryTitle}
      total={total}
      shown={entries.length}
      action={
        <SectionLink link={<Link to="/settings/memory" search={{ project: props.projectKey }} />}>
          {copy.memoryAllAction}
        </SectionLink>
      }
    >
      <SectionBody state={state} empty={copy.memoryEmpty} error={copy.memoryError}>
        {entries.map((entry) => (
          <div key={entry.id} className="flex min-w-0 items-baseline gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{entry.summary}</span>
              {entry.tags.length > 0 || entry.promotionStatus !== "none" ? (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {[entry.promotionStatus === "none" ? null : entry.promotionStatus, ...entry.tags]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatRelativeTimeLabel(entry.updatedAt)}
            </span>
          </div>
        ))}
      </SectionBody>
    </HomeSectionFrame>
  );
}

const SECRET_STATUS_LABEL = { requested: "Requested", missing: "Missing" } as const;

function ProjectSecretsSection(props: {
  readonly secretsState: QueryDisplayState;
  readonly secrets: ReturnType<typeof projectPageSecrets>;
}) {
  return (
    <HomeSectionFrame
      testId="project-secrets"
      title={copy.secretsTitle}
      total={props.secrets.length}
      shown={props.secrets.length}
      action={
        <SectionLink link={<Link to="/settings/secrets" />}>{copy.secretsManageAction}</SectionLink>
      }
    >
      <SectionBody state={props.secretsState} empty={copy.secretsEmpty} error={copy.secretsError}>
        {props.secrets.map((secret) => (
          <div
            key={secret.key}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2"
          >
            <code className="min-w-0 truncate font-mono text-sm text-foreground">
              ${secret.key}
            </code>
            {secret.label ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{secret.label}</span>
            ) : null}
            <span aria-hidden="true" className="flex-1" />
            {secret.status === "stored" ? null : (
              <Badge variant="warning" size="sm">
                {SECRET_STATUS_LABEL[secret.status]}
              </Badge>
            )}
            {secret.delivery === "brokered" ? (
              <Badge variant="info" size="sm">
                Brokered
              </Badge>
            ) : (
              <Badge variant="outline" size="sm">
                File
              </Badge>
            )}
            <span className="w-20 text-right text-xs text-muted-foreground">
              {secret.scope === "project" ? "This project" : "All projects"}
            </span>
          </div>
        ))}
      </SectionBody>
    </HomeSectionFrame>
  );
}

function ProjectRuntimeToolsSection(props: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly projectIds: ReadonlySet<string>;
}) {
  const toolsQuery = useQuery(
    homelabRuntimeToolsQueryOptions({ environmentId: props.environmentId }),
  );
  const tools = useMemo(
    () => projectPageRuntimeTools(toolsQuery.data?.tools ?? [], props.projectIds),
    [props.projectIds, toolsQuery.data],
  );
  const state = queryDisplayState(toolsQuery, () => tools.length === 0);
  return (
    <HomeSectionFrame
      testId="project-runtime-tools"
      title={copy.toolsTitle}
      total={tools.length}
      shown={tools.length}
      action={
        <SectionLink link={<Link to="/settings/project-runtime" />}>
          {copy.toolsManageAction}
        </SectionLink>
      }
    >
      <SectionBody state={state} empty={copy.toolsEmpty} error={copy.toolsError}>
        {tools.map((tool) => (
          <div key={tool.spec} className="flex min-w-0 items-baseline gap-3 py-2">
            <span className="min-w-0 flex-1">
              <code className="block truncate font-mono text-sm text-foreground">{tool.spec}</code>
              <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                {runtimeToolInstallSummary(tool)}
              </span>
              {tool.reason ? (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {tool.reason}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatRelativeTimeLabel(tool.createdAt)}
            </span>
          </div>
        ))}
      </SectionBody>
    </HomeSectionFrame>
  );
}

function ProjectEgressSection(props: {
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly runtimeIds: ReadonlySet<string>;
  readonly threadIds: ReadonlySet<string>;
}) {
  // Same cache entry as Settings → Secrets → Egress activity.
  const auditQuery = useQuery(
    homelabEgressAuditQueryOptions({
      environmentId: props.environmentId,
      limit: EGRESS_AUDIT_LIMIT,
    }),
  );
  const entries = useMemo(
    () =>
      projectPageEgressActivity(auditQuery.data?.entries ?? [], {
        runtimeIds: props.runtimeIds,
        threadIds: props.threadIds,
      }),
    [auditQuery.data, props.runtimeIds, props.threadIds],
  );
  const state = queryDisplayState(auditQuery, () => entries.length === 0);
  // Reading the audit log needs a scope some sessions lack; skip the section then.
  if (state === "error") return null;
  return (
    <HomeSectionFrame
      testId="project-egress"
      title={copy.egressTitle}
      total={entries.length}
      shown={entries.length}
      action={
        <SectionLink link={<Link to="/settings/secrets" />}>{copy.egressAllAction}</SectionLink>
      }
    >
      <SectionBody state={state} empty={copy.egressEmpty} error={copy.egressError}>
        {entries.map((entry) => (
          <div key={entry.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <Badge variant={EGRESS_AUDIT_DECISION_BADGE[entry.decision]} size="sm">
              {EGRESS_AUDIT_DECISION_LABEL[entry.decision]}
            </Badge>
            <span className="font-mono text-xs font-medium text-foreground">{entry.method}</span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-mono text-xs",
                entry.decision === "blocked" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {describeEgressTarget(entry)}
            </span>
            <code className="text-xs text-muted-foreground">${entry.secretKey}</code>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatRelativeTimeLabel(entry.at)}
            </span>
          </div>
        ))}
      </SectionBody>
    </HomeSectionFrame>
  );
}
