/**
 * Homelab additions to Settings -> Providers: Project Runtime readiness for
 * each provider instance (via `ProviderInstanceCard`'s `footer`) and the
 * environment-wide "N/M runtime ready" row. Mounted from the upstream
 * `ProviderSettingsPanel` with one line each.
 */
import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";
import { deriveProviderReadinessForInstance } from "../../setupReadinessReadModel";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import {
  describeProviderRuntimeReadiness,
  providerUpdateAttention,
  readinessBadgeVariant,
  summarizeRuntimeReadiness,
} from "./ProviderHomelabCardFooter.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ProviderHomelabCardFooter(props: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly liveProvider: ServerProvider | undefined;
}) {
  const readiness = deriveProviderReadinessForInstance({
    liveProvider: props.liveProvider,
    instance: props.instance,
    instanceId: props.instanceId,
  });
  const { detail, blocked } = describeProviderRuntimeReadiness(readiness);
  const update = providerUpdateAttention(props.liveProvider);

  return (
    <SettingsSection title={HOMELAB_PRODUCT_COPY.providers.runtimeReadinessTitle}>
      <SettingsRow
        title={readiness.statusLabel}
        description={
          <>
            {detail}
            {blocked ? <span className="mt-1 block text-warning-foreground">{blocked}</span> : null}
          </>
        }
        control={
          <div
            className="flex min-w-0 flex-wrap justify-end gap-1.5"
            aria-label={`${readiness.displayName} Project Runtime readiness`}
          >
            {readiness.badges.map((badge) => (
              <Badge key={badge.id} size="sm" variant={readinessBadgeVariant(badge.severity)}>
                {badge.label}
              </Badge>
            ))}
          </div>
        }
      >
        {update ? (
          <div
            className={cn(
              "mt-3 rounded-md border px-2.5 py-2 text-xs leading-5",
              update.tone === "error"
                ? "border-destructive/30 bg-destructive/8 text-destructive"
                : "border-warning/30 bg-warning/8 text-warning-foreground",
            )}
          >
            <p className="font-medium">{update.title}</p>
            {update.message ? <p>{update.message}</p> : null}
            {update.output ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer select-none font-medium text-foreground">
                  Command output
                </summary>
                <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 font-mono text-xs text-foreground">
                  {update.output}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

export function ProviderRuntimeReadinessSection(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const summary = useMemo(
    () =>
      summarizeRuntimeReadiness(
        props.providers.map((provider) =>
          deriveProviderReadinessForInstance({
            liveProvider: provider,
            instanceId: provider.instanceId,
          }),
        ),
      ),
    [props.providers],
  );

  return (
    <SettingsSection title={HOMELAB_PRODUCT_COPY.providers.runtimeReadinessTitle}>
      <SettingsRow
        title={HOMELAB_PRODUCT_COPY.projectRuntime.title}
        description={
          <>
            {HOMELAB_PRODUCT_COPY.providers.runtimeReadinessDescription}
            <span className="mt-1 block">
              {HOMELAB_PRODUCT_COPY.providers.runtimeVerificationDescription}
            </span>
          </>
        }
        control={<Badge variant="outline">{summary}</Badge>}
      />
    </SettingsSection>
  );
}
