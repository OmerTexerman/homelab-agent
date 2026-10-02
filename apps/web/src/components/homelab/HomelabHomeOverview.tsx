import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ProjectRuntimeDetail, ScopedProjectRef } from "@t3tools/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import {
  HOME_SECTION_LIMIT,
  deriveHomeOverview,
  homeProjectKey,
  homeProjectsInDisplayOrder,
  type HomeAttentionItem,
  type HomeAttentionKind,
  type HomeProjectRow,
  type HomeRuntimeDetailState,
  type HomeRuntimeTone,
  type HomeTarget,
  type HomeThreadRow,
} from "../../homelab/homeOverview";
import { queryDisplayState } from "../../homelab/queryDisplayState";
import { requestDraftAutoSend } from "../../homelab/draftAutoSend";
import { useCreateStandaloneThread } from "../../homelab/useCreateStandaloneThread";
import { useUserVisibleProjects, useUserVisibleThreadShells } from "../../homelab/visibleProjects";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { homeLogicalProjectKeys } from "../../homelab/projectPage";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { useHomelabMutation } from "../../homelab/useHomelabMutation";
import {
  acknowledgeHomelabCheckRequest,
  homelabChecksQueryKeys,
  homelabChecksQueryOptions,
} from "../../lib/homelabChecksReactQuery";
import { homelabEgressApprovalsQueryOptions } from "../../lib/homelabEgressReactQuery";
import { homelabSecretsQueryOptions } from "../../lib/homelabSecretsReactQuery";
import { projectRuntimeDetailQueryOptions } from "../../lib/projectRuntimeReactQuery";
import { cn } from "../../lib/utils";
import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";
import { useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { NoProjectsHero } from "../NoProjectsHero";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  EgressApprovalActions,
  EgressApprovalTimeLeft,
  useEgressApprovalDecision,
} from "./EgressApprovalActions";

type ExpandableSection = "attention" | "running" | "projects" | "recent";

const copy = HOMELAB_PRODUCT_COPY.homeOverview;

/**
 * The home page: what needs the user, what is running, every project's
 * runtime, and recent threads, under a prompt that starts a thread in one
 * step. Rendered by the `/` route and by ChatView when no thread is open.
 *
 * `emptyState` renders when there are no projects and no threads at all; the
 * index route passes upstream's landing so first-run behavior stays theirs.
 */
export function HomelabHomeOverview({ emptyState }: { readonly emptyState?: ReactNode }) {
  const projects = useUserVisibleProjects();
  const threads = useUserVisibleThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [expanded, setExpanded] = useState<ReadonlySet<ExpandableSection>>(() => new Set());
  const startThreadIn = useStartThreadIn();
  const projectGroups = useSettingsProjectGroups();
  const logicalProjectKeys = useMemo(() => homeLogicalProjectKeys(projectGroups), [projectGroups]);

  const orderedProjects = useMemo(
    () => homeProjectsInDisplayOrder(projects, threads),
    [projects, threads],
  );
  // Runtime status is read only for the project rows on screen. A runtime
  // fails or queues a rebuild when a thread uses it, which also makes its
  // project recently active, so the visible rows cover what matters.
  const trackedProjects = useMemo(
    () =>
      expanded.has("projects") ? orderedProjects : orderedProjects.slice(0, HOME_SECTION_LIMIT),
    [expanded, orderedProjects],
  );
  const runtimeStates = useQueries({
    queries: trackedProjects.map((project) =>
      projectRuntimeDetailQueryOptions({
        environmentId: project.environmentId,
        projectId: project.id,
        runtimeId: project.defaultRuntimeId ?? null,
      }),
    ),
    combine: combineRuntimeStates,
  });
  // Shares the cache entry (and polling) of the global secret-request prompt.
  const secretsQuery = useQuery(
    homelabSecretsQueryOptions({ environmentId: primaryEnvironmentId }),
  );

  // Shares the cache entry (and polling) of the global egress approval prompt.
  const egressApprovalsQuery = useQuery(
    homelabEgressApprovalsQueryOptions({ environmentId: primaryEnvironmentId }),
  );

  // Scheduled checks whose last result needs attention.
  const checksQuery = useQuery(homelabChecksQueryOptions({ environmentId: primaryEnvironmentId }));

  const runtimeDetails = useMemo(() => {
    const details = new Map<string, HomeRuntimeDetailState>();
    trackedProjects.forEach((project, index) => {
      details.set(
        homeProjectKey({ environmentId: project.environmentId, projectId: project.id }),
        runtimeStates[index] ?? { status: "loading" },
      );
    });
    return details;
  }, [runtimeStates, trackedProjects]);

  const secretsData = secretsQuery.data;
  const secretsStatus = secretsQuery.status;
  const secrets = useMemo(() => {
    if (primaryEnvironmentId === null) return null;
    return {
      environmentId: primaryEnvironmentId,
      state: queryDisplayState({ status: secretsStatus, data: secretsData }, (data) =>
        data.secrets.every((secret) => !secret.pending),
      ),
      secrets: secretsData?.secrets ?? [],
    };
  }, [primaryEnvironmentId, secretsData, secretsStatus]);

  const egressData = egressApprovalsQuery.data;
  const egressStatus = egressApprovalsQuery.status;
  const egressApprovals = useMemo(() => {
    if (primaryEnvironmentId === null) return null;
    return {
      environmentId: primaryEnvironmentId,
      state: queryDisplayState(
        { status: egressStatus, data: egressData },
        (data) => data.approvals.length === 0,
      ),
      approvals: egressData?.approvals ?? [],
    };
  }, [egressData, egressStatus, primaryEnvironmentId]);

  const checksData = checksQuery.data;
  const checksStatus = checksQuery.status;
  const checks = useMemo(() => {
    if (primaryEnvironmentId === null) return null;
    return {
      environmentId: primaryEnvironmentId,
      state: queryDisplayState({ status: checksStatus, data: checksData }, (data) =>
        data.checks.every((check) => !check.needsAttention),
      ),
      checks: checksData?.checks ?? [],
    };
  }, [checksData, checksStatus, primaryEnvironmentId]);

  const model = useMemo(
    () =>
      deriveHomeOverview({
        bootstrapped,
        projects,
        threads,
        runtimeDetails,
        secrets,
        egressApprovals,
        checks,
        limits: {
          attention: expanded.has("attention") ? Infinity : HOME_SECTION_LIMIT,
          running: expanded.has("running") ? Infinity : HOME_SECTION_LIMIT,
          projects: expanded.has("projects") ? Infinity : HOME_SECTION_LIMIT,
          recent: expanded.has("recent") ? Infinity : HOME_SECTION_LIMIT,
        },
      }),
    [bootstrapped, checks, egressApprovals, expanded, projects, runtimeDetails, secrets, threads],
  );

  const toggle = useCallback((section: ExpandableSection) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  if (model.status === "empty") {
    return <>{emptyState ?? <NoProjectsHero />}</>;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
            {copy.title}
          </span>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div
            data-testid="home-overview"
            className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10"
          >
            <HomeStartPrompt projects={orderedProjects} startThreadIn={startThreadIn} />
            {model.status === "loading" ? (
              <HomeLoadingRows />
            ) : (
              <>
                <HomeSectionFrame
                  testId="home-attention"
                  title={copy.attentionTitle}
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
                    <p className="py-2 text-sm text-muted-foreground">
                      {model.attention.complete ? copy.attentionEmpty : copy.attentionChecking}
                    </p>
                  )}
                </HomeSectionFrame>

                {model.running.total > 0 ? (
                  <HomeSectionFrame
                    testId="home-running"
                    title={copy.runningTitle}
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

                {model.projects.total > 0 ? (
                  <HomeSectionFrame
                    testId="home-projects"
                    title={copy.projectsTitle}
                    total={model.projects.total}
                    shown={model.projects.items.length}
                    expanded={expanded.has("projects")}
                    onToggle={() => toggle("projects")}
                  >
                    {model.projects.items.map((row) => (
                      <ProjectRow
                        key={row.id}
                        row={row}
                        projectKey={logicalProjectKeys.get(row.id) ?? null}
                        startThreadIn={startThreadIn}
                      />
                    ))}
                  </HomeSectionFrame>
                ) : null}

                <HomeSectionFrame
                  testId="home-recent"
                  title={copy.recentTitle}
                  total={model.recent.total}
                  shown={model.recent.items.length}
                  expanded={expanded.has("recent")}
                  onToggle={() => toggle("recent")}
                >
                  {model.recent.items.length > 0 ? (
                    model.recent.items.map((row) => <ThreadRow key={row.id} row={row} />)
                  ) : (
                    <p className="py-2 text-sm text-muted-foreground">{copy.recentEmpty}</p>
                  )}
                </HomeSectionFrame>
              </>
            )}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

/**
 * "Start a thread in <project>": opens a new thread in the chosen project and
 * sends the typed text as its first message. With no text it opens an empty
 * draft.
 */
export function HomeStartPrompt({
  projects,
  startThreadIn,
  defaultProjectKey = null,
  showScratchAction = true,
}: {
  readonly projects: ReadonlyArray<HomeProjectOption>;
  readonly startThreadIn: StartThreadIn;
  /** `homeProjectKey` of the project to preselect; defaults to the most recently active. */
  readonly defaultProjectKey?: string | null;
  /** The "New scratch thread" button; off on a project's own page. */
  readonly showScratchAction?: boolean;
}) {
  const createStandaloneThread = useCreateStandaloneThread();
  const [prompt, setPrompt] = useState("");
  const [pickedKey, setPickedKey] = useState<string | null>(defaultProjectKey);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const options = useMemo(
    () =>
      projects.map((project) => ({
        key: homeProjectKey({ environmentId: project.environmentId, projectId: project.id }),
        project,
      })),
    [projects],
  );
  // Default to the most recently active project, like upstream's landing draft.
  const selected = options.find((option) => option.key === pickedKey) ?? options[0] ?? null;

  useEffect(() => {
    // Keyboard users land in the prompt; touch devices keep their keyboard closed.
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches) {
      textareaRef.current?.focus();
    }
  }, []);

  const start = async () => {
    // The ref, not state, stops a key repeat from opening two drafts.
    if (selected === null || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const opened = await startThreadIn(
        scopeProjectRef(selected.project.environmentId, selected.project.id),
      );
      // The prompt goes through the draft's own composer send, so the thread
      // gets exactly the model and modes a send from the thread would.
      if (opened !== null && prompt.trim().length > 0) {
        useComposerDraftStore.getState().setPrompt(opened.draftId, prompt);
        requestDraftAutoSend(opened.draftId);
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  return (
    <form
      data-testid="home-start"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-2 shadow-xs/5"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <label htmlFor="home-start-prompt" className="sr-only">
        {copy.promptLabel}
      </label>
      <Textarea
        id="home-start-prompt"
        ref={textareaRef}
        unstyled
        value={prompt}
        placeholder={copy.promptPlaceholder}
        disabled={selected === null}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void start();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {selected !== null ? (
            <>
              <span className="shrink-0">{copy.promptProjectLabel}</span>
              <Select
                value={selected.key}
                items={Object.fromEntries(
                  options.map((option) => [option.key, option.project.title]),
                )}
                onValueChange={(value) => {
                  if (typeof value === "string") setPickedKey(value);
                }}
              >
                <SelectTrigger
                  size="xs"
                  variant="ghost"
                  className="min-w-0 max-w-48"
                  aria-label={copy.promptProjectAriaLabel}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {options.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </>
          ) : (
            <span>{copy.promptNoProject}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {showScratchAction ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void createStandaloneThread()}
            >
              <SquarePenIcon className="size-4" />
              {HOMELAB_PRODUCT_COPY.standalone.newThreadAction}
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={selected === null || starting}>
            <ArrowUpIcon className="size-4" />
            {copy.startAction}
          </Button>
        </div>
      </div>
    </form>
  );
}

export type HomeProjectOption = ReturnType<typeof homeProjectsInDisplayOrder>[number];

export type StartThreadIn = ReturnType<typeof useStartThreadIn>;

/** Opens a new draft in a project (the shared new-thread flow); failures toast. */
export function useStartThreadIn() {
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    (ref: ScopedProjectRef) =>
      handleNewThread(ref).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: copy.startFailedTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return null;
      }),
    [handleNewThread],
  );
}

/**
 * Module-level so TanStack keeps the combined array referentially stable
 * until a runtime read actually changes.
 */
export function combineRuntimeStates(
  results: ReadonlyArray<{
    readonly status: "pending" | "error" | "success";
    readonly data: ProjectRuntimeDetail | undefined;
  }>,
): HomeRuntimeDetailState[] {
  return results.map((result) =>
    result.data !== undefined
      ? { status: "ready", detail: result.data }
      : result.status === "error"
        ? { status: "error" }
        : { status: "loading" },
  );
}

export function HomeSectionFrame(props: {
  readonly testId: string;
  readonly title: string;
  readonly total: number;
  readonly shown: number;
  /** Sections without a toggle show every row they are given. */
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  /** Rendered at the end of the heading line, e.g. a link to the full list. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const expanded = props.expanded ?? false;
  const canToggle = props.onToggle !== undefined && (expanded || props.shown < props.total);
  return (
    <section data-testid={props.testId} className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-3">
        <h2 className="shrink-0 font-mono text-2xs font-medium uppercase tracking-widest text-muted-foreground">
          {props.title}
        </h2>
        {props.total > 0 ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/70">
            {props.total}
          </span>
        ) : null}
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border/60" />
        {props.action}
        {canToggle ? (
          <Button variant="ghost" size="compact" onClick={props.onToggle}>
            {expanded ? copy.showFewer : `${copy.showAll} (${props.total})`}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col divide-y divide-border/50">{props.children}</div>
    </section>
  );
}

const ROW_CLASS =
  "group -mx-2 flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring";

export function AttentionRow({
  item,
  startThreadIn,
}: {
  readonly item: HomeAttentionItem;
  readonly startThreadIn: StartThreadIn;
}) {
  if (item.egressApproval) {
    return (
      <EgressApprovalAttentionRow
        item={item}
        approval={item.egressApproval}
        startThreadIn={startThreadIn}
      />
    );
  }
  if (item.check && item.checkEnvironmentId) {
    return (
      <CheckAttentionRow
        item={item}
        checkId={item.check.id}
        environmentId={item.checkEnvironmentId}
        startThreadIn={startThreadIn}
      />
    );
  }
  const body = (
    <>
      <StatusDot className={ATTENTION_DOT[item.kind]} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
        <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
          <span className={cn("truncate", ATTENTION_TEXT[item.kind])}>{item.reason}</span>
          {item.context ? <span className="shrink-0 truncate">{item.context}</span> : null}
        </span>
      </span>
      {item.timestamp ? <RowTime iso={item.timestamp} /> : null}
    </>
  );
  return (
    <TargetLink target={item.target} startThreadIn={startThreadIn}>
      {body}
    </TargetLink>
  );
}

/**
 * A held egress write: what and where, which secret and thread, the time left,
 * and inline decisions (the row link itself opens the thread).
 */
function EgressApprovalAttentionRow({
  item,
  approval,
  startThreadIn,
}: {
  readonly item: HomeAttentionItem;
  readonly approval: NonNullable<HomeAttentionItem["egressApproval"]>;
  readonly startThreadIn: StartThreadIn;
}) {
  const decision = useEgressApprovalDecision();
  return (
    <div data-testid="home-egress-approval" className="flex min-w-0 flex-col gap-1 py-1">
      <TargetLink target={item.target} startThreadIn={startThreadIn}>
        <StatusDot className={ATTENTION_DOT[item.kind]} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm font-medium text-foreground">
            {item.title}
          </span>
          <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
            <span className={cn("truncate", ATTENTION_TEXT[item.kind])}>{item.reason}</span>
            {item.context ? <span className="shrink-0 truncate">{item.context}</span> : null}
          </span>
        </span>
        <EgressApprovalTimeLeft
          expiresAt={approval.expiresAt}
          className={cn("text-xs", ATTENTION_TEXT[item.kind])}
        />
      </TargetLink>
      <EgressApprovalActions approval={approval} decision={decision} className="pl-5" />
    </div>
  );
}

/**
 * A scheduled check whose last result needs attention: the row opens the
 * check's thread, and Acknowledge clears it until the next attention result.
 */
function CheckAttentionRow({
  item,
  checkId,
  environmentId,
  startThreadIn,
}: {
  readonly item: HomeAttentionItem;
  readonly checkId: string;
  readonly environmentId: NonNullable<HomeAttentionItem["checkEnvironmentId"]>;
  readonly startThreadIn: StartThreadIn;
}) {
  const acknowledge = useHomelabMutation({
    mutationFn: () => acknowledgeHomelabCheckRequest({ environmentId, checkId }),
    invalidate: [homelabChecksQueryKeys.all],
    errorToast: "Couldn't acknowledge the check",
  });
  return (
    <div data-testid="home-check-attention" className="flex min-w-0 items-center gap-1">
      <TargetLink target={item.target} startThreadIn={startThreadIn} className="flex-1">
        <StatusDot className={ATTENTION_DOT[item.kind]} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
          <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
            <span className={cn("truncate", ATTENTION_TEXT[item.kind])}>{item.reason}</span>
            {item.context ? <span className="shrink-0 truncate">{item.context}</span> : null}
          </span>
        </span>
        {item.timestamp ? <RowTime iso={item.timestamp} /> : null}
      </TargetLink>
      <Button
        variant="ghost"
        size="sm"
        disabled={acknowledge.isPending}
        onClick={() => void acknowledge.submit()}
      >
        Acknowledge
      </Button>
    </div>
  );
}

export function ThreadRow({ row }: { readonly row: HomeThreadRow }) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(row.ref)}
      className={ROW_CLASS}
    >
      <StatusDot className={THREAD_DOT[row.status]} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{row.title}</span>
        <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
          {row.context ? <span className="shrink-0 truncate">{row.context}</span> : null}
          {row.isIsolated ? <span className="shrink-0">{copy.isolatedLabel}</span> : null}
          {row.statusLabel ? (
            <span className={cn("truncate", THREAD_TEXT[row.status])}>{row.statusLabel}</span>
          ) : null}
        </span>
      </span>
      <RowTime iso={row.timestamp} />
    </Link>
  );
}

function ProjectRow({
  row,
  projectKey,
  startThreadIn,
}: {
  readonly row: HomeProjectRow;
  /** The project page's key; null falls back to opening the latest thread. */
  readonly projectKey: string | null;
  readonly startThreadIn: StartThreadIn;
}) {
  const summary = [
    row.threadCount === 1 ? "1 thread" : `${row.threadCount} threads`,
    row.runningCount > 0 ? `${row.runningCount} running` : null,
    row.attentionCount > 0 ? `${row.attentionCount} waiting on you` : null,
    row.queueLabel,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const body = (
    <>
      <StatusDot className={RUNTIME_DOT[row.runtimeTone]} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{row.title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
      </span>
      <span className="shrink-0 text-right">
        {row.runtimeStatus === "loading" ? (
          <Placeholder className="ml-auto h-3 w-14" />
        ) : row.runtimeStatus === "ready" ? (
          <span
            className={cn(
              "block font-mono text-3xs uppercase tracking-wider",
              row.runtimeTone === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {row.runtimeLabel}
          </span>
        ) : null}
        <span className="block text-xs tabular-nums text-muted-foreground">
          {formatRelativeTimeLabel(row.lastActivityAt)}
        </span>
      </span>
    </>
  );
  return (
    <div className="flex min-w-0 items-center gap-1">
      {projectKey !== null ? (
        <Link
          to="/projects/$projectKey"
          params={{ projectKey }}
          className={cn(ROW_CLASS, "flex-1")}
        >
          {body}
        </Link>
      ) : (
        <TargetLink
          target={{ kind: "project", ref: row.ref, latestThreadRef: row.latestThreadRef }}
          startThreadIn={startThreadIn}
          className="flex-1"
        >
          {body}
        </TargetLink>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${copy.newThreadInAction} ${row.title}`}
        onClick={() => void startThreadIn(row.ref)}
      >
        <PlusIcon className="size-4" />
      </Button>
    </div>
  );
}

/** A row that opens its target: a thread, a project's latest thread, or Settings → Secrets. */
function TargetLink(props: {
  readonly target: HomeTarget;
  readonly startThreadIn: StartThreadIn;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { startThreadIn } = props;
  const className = cn(ROW_CLASS, props.className);
  const { target } = props;
  if (target.kind === "secrets") {
    return (
      <Link to="/settings/secrets" className={className}>
        {props.children}
      </Link>
    );
  }
  const threadRef = target.kind === "thread" ? target.ref : target.latestThreadRef;
  if (threadRef !== null) {
    return (
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(threadRef)}
        className={className}
      >
        {props.children}
      </Link>
    );
  }
  // A project with no threads yet: opening it starts one.
  const projectRef = target.kind === "project" ? target.ref : null;
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (projectRef) void startThreadIn(projectRef);
      }}
    >
      {props.children}
    </button>
  );
}

function RowTime({ iso }: { readonly iso: string }) {
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatRelativeTimeLabel(iso)}
    </span>
  );
}

export function StatusDot({ className }: { readonly className: string }) {
  return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", className)} />;
}

/**
 * Static loading blocks. Not `Skeleton`: its shimmer runs until data arrives,
 * and a disconnected server can keep this page loading indefinitely.
 */
export function Placeholder({ className }: { readonly className: string }) {
  return (
    <span aria-hidden="true" className={cn("block rounded-sm bg-muted-foreground/15", className)} />
  );
}

export function HomeLoadingRows() {
  return (
    <div data-testid="home-loading" className="flex flex-col gap-3" aria-busy="true">
      <span className="sr-only">Loading</span>
      <Placeholder className="h-3 w-24" />
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-3">
          <Placeholder className="size-2 rounded-full" />
          <Placeholder className="h-4 flex-1" />
          <Placeholder className="h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

const AMBER_DOT = "bg-amber-500 dark:bg-amber-300/90";
const AMBER_TEXT = "text-amber-600 dark:text-amber-300/90";
const SKY_DOT = "bg-sky-500 dark:bg-sky-300/80";

const ATTENTION_DOT: Record<HomeAttentionKind, string> = {
  "egress-approval": AMBER_DOT,
  approval: AMBER_DOT,
  "user-input": "bg-indigo-500 dark:bg-indigo-300/90",
  "secret-request": AMBER_DOT,
  "runtime-failed": "bg-destructive",
  "thread-failed": "bg-destructive",
  "check-attention": AMBER_DOT,
  "plan-ready": "bg-violet-500 dark:bg-violet-300/90",
  "runtime-rebuild-pending": "bg-muted-foreground/50",
};

const ATTENTION_TEXT: Record<HomeAttentionKind, string> = {
  "egress-approval": AMBER_TEXT,
  approval: AMBER_TEXT,
  "user-input": "text-indigo-600 dark:text-indigo-300/90",
  "secret-request": AMBER_TEXT,
  "runtime-failed": "text-destructive",
  "thread-failed": "text-destructive",
  "check-attention": AMBER_TEXT,
  "plan-ready": "text-violet-600 dark:text-violet-300/90",
  "runtime-rebuild-pending": "",
};

// Static dots only: an idle page must not repaint.
const THREAD_DOT: Record<SidebarThreadStatus, string> = {
  approval: AMBER_DOT,
  input: "bg-indigo-500 dark:bg-indigo-300/90",
  working: SKY_DOT,
  monitoring: SKY_DOT,
  failed: "bg-destructive",
  ready: "bg-muted-foreground/30",
};

const THREAD_TEXT: Record<SidebarThreadStatus, string> = {
  approval: AMBER_TEXT,
  input: "text-indigo-600 dark:text-indigo-300/90",
  working: "text-sky-600 dark:text-sky-300/80",
  monitoring: "text-sky-600 dark:text-sky-300/80",
  failed: "text-destructive",
  ready: "",
};

export const RUNTIME_DOT: Record<HomeRuntimeTone, string> = {
  active: "bg-emerald-500 dark:bg-emerald-300/90",
  idle: "bg-emerald-500/50 dark:bg-emerald-300/50",
  asleep: "bg-muted-foreground/40",
  failed: "bg-destructive",
  unknown: "bg-muted-foreground/20",
};
