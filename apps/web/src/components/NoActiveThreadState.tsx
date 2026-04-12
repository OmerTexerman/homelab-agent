import {
  BotIcon,
  ChevronRightIcon,
  DatabaseIcon,
  KeyRoundIcon,
  LoaderIcon,
  Settings2Icon,
  WrenchIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useServerProviders } from "../rpc/serverState";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { homelabSetupStatusQueryOptions } from "../lib/homelabReactQuery";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";

export function NoActiveThreadState() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providerStatuses = useServerProviders();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const homelabSetupStatusQuery = useQuery(
    homelabSetupStatusQueryOptions({
      environmentId: primaryEnvironmentId,
      enabled: primaryEnvironmentId !== null,
    }),
  );
  const homelabSetupStatus = homelabSetupStatusQuery.data;
  const readyProviders = providerStatuses.filter(
    (provider) =>
      provider.enabled && provider.installed && provider.auth.status === "authenticated",
  ).length;
  const secretCount = homelabSetupStatus?.secrets.secrets.length ?? 0;
  const missingSecretCount =
    homelabSetupStatus?.secrets.secrets.filter((secret) => !secret.hasValue).length ?? 0;
  const entityCount = homelabSetupStatus?.snapshot.entities.length ?? 0;
  const relationCount = homelabSetupStatus?.snapshot.relations.length ?? 0;
  const bootstrapMutationCount = homelabSetupStatus?.runtimeBootstrap.mutations.length ?? 0;
  const entities = homelabSetupStatus?.snapshot.entities ?? [];
  const relations = homelabSetupStatus?.snapshot.relations ?? [];
  const entityById = new Map(entities.map((entity) => [entity.id, entity] as const));
  const entityKindCounts = Array.from(
    entities.reduce<Map<string, number>>((counts, entity) => {
      counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
      return counts;
    }, new Map()),
  ).toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const recentEntities = [...entities]
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 6);
  const visibleRelations = relations
    .map((relation) => ({
      relation,
      from: entityById.get(relation.fromEntityId),
      to: entityById.get(relation.toEntityId),
    }))
    .filter((entry) => entry.from && entry.to)
    .slice(0, 6);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            <section className="overflow-hidden rounded-3xl border border-border/60 bg-card/35 shadow-sm">
              <div className="border-b border-border/60 px-6 py-6">
                <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  Homelab Agent
                </p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                  Thread runtimes stay thin. Homelab context comes from tools.
                </h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                  New threads start with lightweight operating instructions, then pull the current
                  architecture, services, secrets, and runtime bootstrap state from the shared
                  homelab system as they work.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      if (!defaultProjectRef) {
                        return;
                      }
                      void handleNewThread(defaultProjectRef);
                    }}
                    disabled={!defaultProjectRef}
                  >
                    <BotIcon className="size-4" />
                    New thread
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void navigate({ to: "/settings/general" })}
                  >
                    <Settings2Icon className="size-4" />
                    Open settings
                  </Button>
                  <Button variant="ghost" onClick={() => void homelabSetupStatusQuery.refetch()}>
                    Refresh status
                  </Button>
                </div>
                {!defaultProjectRef ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Create a logical project in the sidebar first, then start a thread inside it.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
                <StatusCard
                  icon={<BotIcon className="size-4" />}
                  label="Providers"
                  value={`${readyProviders}/${providerStatuses.length}`}
                  detail="Authenticated provider CLIs ready for runtime sessions."
                />
                <StatusCard
                  icon={<KeyRoundIcon className="size-4" />}
                  label="Secrets"
                  value={String(secretCount)}
                  detail={
                    missingSecretCount > 0
                      ? `${missingSecretCount} placeholders still need values.`
                      : "Secret refs are populated or ready to be requested."
                  }
                />
                <StatusCard
                  icon={<DatabaseIcon className="size-4" />}
                  label="Knowledge"
                  value={String(entityCount)}
                  detail={`${relationCount} graph relations currently tracked.`}
                />
                <StatusCard
                  icon={<WrenchIcon className="size-4" />}
                  label="Bootstrap"
                  value={String(bootstrapMutationCount)}
                  detail="Shared runtime mutations future threads inherit."
                />
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
              <div className="rounded-3xl border border-border/60 bg-card/25 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">Setup checklist</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The app is healthiest when providers, secret refs, and bootstrap state are in
                      place before you fan out more threads.
                    </p>
                  </div>
                  {homelabSetupStatusQuery.isFetching ? (
                    <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
                <div className="mt-4 grid gap-3">
                  <ChecklistRow
                    title="Authenticate Codex and Claude on the host"
                    detail="Threads mount that auth into their isolated runtime homes."
                    complete={readyProviders > 0}
                  />
                  <ChecklistRow
                    title="Register the secrets agents should be allowed to use"
                    detail="Agents can request placeholders first and avoid raw secret values in chat."
                    complete={secretCount > 0}
                  />
                  <ChecklistRow
                    title="Promote infrastructure knowledge into the shared graph"
                    detail="Hosts, services, endpoints, runbooks, and findings should live outside any one thread."
                    complete={entityCount > 0}
                  />
                  <ChecklistRow
                    title="Keep runtime bootstrap intentional"
                    detail="Mutations should explain what future runtimes need and why."
                    complete={bootstrapMutationCount > 0}
                  />
                </div>
              </div>

              <div className="rounded-3xl border border-border/60 bg-card/25 p-5">
                <h2 className="text-sm font-semibold text-foreground">Runtime tools</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Inside each thread runtime, use the `homelab` CLI instead of relying on static
                  prompt context.
                </p>
                <div className="mt-4 space-y-2 rounded-2xl border border-border/60 bg-background/40 p-4 font-mono text-xs text-muted-foreground">
                  <div>`homelab search grafana`</div>
                  <div>`homelab secrets`</div>
                  <div>`homelab secret-request API_KEY --summary "Grafana cloud token"`</div>
                  <div>`homelab bootstrap`</div>
                  <div>`homelab promote --file promotion.json`</div>
                </div>
                <button
                  type="button"
                  className="mt-4 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => void navigate({ to: "/settings/general" })}
                >
                  Manage providers and secrets
                  <ChevronRightIcon className="size-4" />
                </button>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
              <div className="rounded-3xl border border-border/60 bg-card/25 p-5">
                <div className="flex items-center gap-2">
                  <DatabaseIcon className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Homelab graph</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  This is the shared model of your homelab that threads should query instead of
                  rediscovering everything from scratch.
                </p>
                {entityKindCounts.length > 0 ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {entityKindCounts.map(([kind, count]) => (
                      <div
                        key={kind}
                        className="rounded-2xl border border-border/60 bg-background/35 px-4 py-3"
                      >
                        <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                          {kind.replaceAll("_", " ")}
                        </div>
                        <div className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                          {count}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
                    No infrastructure entities have been promoted into the graph yet.
                  </div>
                )}
              </div>

              <div className="rounded-3xl border border-border/60 bg-card/25 p-5">
                <h2 className="text-sm font-semibold text-foreground">Current understanding</h2>
                <div className="mt-4 space-y-3">
                  {recentEntities.length > 0 ? (
                    recentEntities.map((entity) => (
                      <div
                        key={entity.id}
                        className="rounded-2xl border border-border/60 bg-background/35 px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {entity.title ?? entity.name}
                            </div>
                            <div className="mt-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                              {entity.kind.replaceAll("_", " ")}
                            </div>
                          </div>
                          <div className="rounded-full border border-border/70 px-2 py-1 text-[10px] text-muted-foreground">
                            {entity.status ?? "unknown"}
                          </div>
                        </div>
                        {entity.summary ? (
                          <p className="mt-2 text-sm leading-5 text-muted-foreground">
                            {entity.summary}
                          </p>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
                      Once threads promote hosts, services, and findings, they will show up here.
                    </div>
                  )}
                </div>
                {visibleRelations.length > 0 ? (
                  <div className="mt-5">
                    <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      Sample relations
                    </div>
                    <div className="mt-2 space-y-2">
                      {visibleRelations.map(({ relation, from, to }) => (
                        <div
                          key={relation.id}
                          className="rounded-2xl border border-border/60 bg-background/35 px-4 py-3 text-sm text-muted-foreground"
                        >
                          <span className="font-medium text-foreground">{from?.name}</span>
                          <span className="mx-2 text-muted-foreground/70">
                            {relation.kind.replaceAll("_", " ")}
                          </span>
                          <span className="font-medium text-foreground">{to?.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            {homelabSetupStatusQuery.isError ? (
              <section className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Could not load homelab setup status.{" "}
                {homelabSetupStatusQuery.error instanceof Error
                  ? homelabSetupStatusQuery.error.message
                  : "Unknown error."}
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function StatusCard(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/45 p-4">
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.icon}
        <span>{props.label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
        {props.value}
      </div>
      <p className="mt-2 text-sm leading-5 text-muted-foreground">{props.detail}</p>
    </div>
  );
}

function ChecklistRow(props: {
  readonly title: string;
  readonly detail: string;
  readonly complete: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/35 px-4 py-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
            props.complete
              ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-300"
              : "border-border bg-muted/30 text-muted-foreground",
          )}
        >
          {props.complete ? "OK" : "TODO"}
        </div>
        <div>
          <div className="text-sm font-medium text-foreground">{props.title}</div>
          <div className="mt-1 text-sm leading-5 text-muted-foreground">{props.detail}</div>
        </div>
      </div>
    </div>
  );
}
