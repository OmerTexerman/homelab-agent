/**
 * Settings → Memory & Knowledge: "Tidy knowledge automatically". Off, or a
 * weekly slot; each run is a new curator session the server starts on its
 * own, so it needs no browser open. Shows the next run and the last result.
 */
import type { CuratorTidyResult, EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import {
  type CuratorTidyDraft,
  curatorTidyDraftFrom,
  curatorTidyInputFromDraft,
} from "../../homelab/curatorTidy";
import { checkStatusBadge, describeNextRun, WEEKDAY_OPTIONS } from "../../homelab/projectChecks";
import { useHomelabMutation } from "../../homelab/useHomelabMutation";
import {
  homelabChecksQueryKeys,
  homelabCuratorTidyQueryOptions,
  runHomelabCheckRequest,
  updateHomelabCuratorTidyRequest,
} from "../../lib/homelabChecksReactQuery";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

const copy = {
  title: "Tidy knowledge automatically",
  description:
    "A curator session that merges duplicates, fixes vague or misfiled entries, and re-verifies stale facts on a schedule, then notifies you with what it changed. Judgment calls are left for you.",
  modeLabel: "Knowledge tidy",
  off: "Off",
  weekly: "Weekly",
  save: "Save",
  runNow: "Run now",
  never: "Never run",
  next: "Next",
  openSession: "Open last session",
  timeZoneNote: (timeZone: string) => `Times are in ${timeZone}.`,
} as const;

const MODE_ITEMS = { off: copy.off, weekly: copy.weekly };
const WEEKDAY_ITEMS = Object.fromEntries(
  WEEKDAY_OPTIONS.map((option) => [String(option.value), option.label]),
);

export function CuratorTidyRow(props: { readonly environmentId: EnvironmentId }) {
  const query = useQuery(homelabCuratorTidyQueryOptions({ environmentId: props.environmentId }));
  return (
    <SettingsRow title={copy.title} description={copy.description}>
      {query.data ? (
        // Keyed on the stored row so a save (or another device's) resets the form.
        <CuratorTidyForm
          key={`${query.data.check?.updatedAt ?? "none"}`}
          environmentId={props.environmentId}
          result={query.data}
        />
      ) : query.isError ? (
        <p className="mt-3 text-xs text-destructive">Couldn't load the knowledge tidy.</p>
      ) : null}
    </SettingsRow>
  );
}

function CuratorTidyForm(props: {
  readonly environmentId: EnvironmentId;
  readonly result: CuratorTidyResult;
}) {
  const { check, timeZone } = props.result;
  const stored = curatorTidyDraftFrom(check);
  const [draft, setDraft] = useState<CuratorTidyDraft>(stored);
  const dirty =
    draft.mode !== stored.mode ||
    (draft.mode === "weekly" && (draft.weekday !== stored.weekday || draft.time !== stored.time));
  const parsed = curatorTidyInputFromDraft(draft);
  const invalidate = [homelabChecksQueryKeys.all];

  const save = useHomelabMutation({
    mutationFn: () => {
      if ("error" in parsed) return Promise.reject(new Error(parsed.error));
      return updateHomelabCuratorTidyRequest({
        environmentId: props.environmentId,
        tidy: parsed.input,
      });
    },
    invalidate,
    successToast: {
      title: draft.mode === "weekly" ? "Knowledge tidy scheduled" : "Knowledge tidy off",
    },
    errorToast: "Couldn't save the knowledge tidy",
  });
  const run = useHomelabMutation({
    mutationFn: (checkId: string) =>
      runHomelabCheckRequest({ environmentId: props.environmentId, checkId }),
    invalidate,
    successToast: { title: "Knowledge tidy started" },
    errorToast: "Couldn't start the knowledge tidy",
  });

  const badge = check === null ? null : checkStatusBadge(check);
  const meta =
    check === null
      ? null
      : [
          check.lastRunAt ? formatRelativeTimeLabel(check.lastRunAt) : copy.never,
          check.nextRunAt ? `${copy.next} ${describeNextRun(check.nextRunAt)}` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ");

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={draft.mode}
          items={MODE_ITEMS}
          onValueChange={(value) => {
            if (value === "off" || value === "weekly") setDraft({ ...draft, mode: value });
          }}
        >
          <SelectTrigger size="sm" className="w-28" aria-label={copy.modeLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="off">{copy.off}</SelectItem>
            <SelectItem value="weekly">{copy.weekly}</SelectItem>
          </SelectPopup>
        </Select>
        {draft.mode === "weekly" ? (
          <>
            <Select
              value={String(draft.weekday)}
              items={WEEKDAY_ITEMS}
              onValueChange={(value) => {
                if (typeof value === "string") setDraft({ ...draft, weekday: Number(value) });
              }}
            >
              <SelectTrigger size="sm" className="w-32" aria-label="Day of the week">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {WEEKDAY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-sm text-muted-foreground">at</span>
            <Input
              type="time"
              size="sm"
              className="w-28"
              value={draft.time}
              aria-label="Time"
              onChange={(event) => setDraft({ ...draft, time: event.target.value })}
            />
          </>
        ) : null}
        {dirty ? (
          <Button
            size="sm"
            disabled={save.isPending || "error" in parsed}
            onClick={() => void save.submit()}
          >
            {copy.save}
          </Button>
        ) : null}
        <span aria-hidden="true" className="flex-1" />
        {check !== null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={check.running || run.isPending}
            onClick={() => void run.submit(check.id)}
          >
            <PlayIcon className="size-3.5" />
            {copy.runNow}
          </Button>
        ) : null}
      </div>
      {draft.mode === "weekly" ? (
        <span className="text-xs text-muted-foreground">{copy.timeZoneNote(timeZone)}</span>
      ) : null}
      {check !== null && badge !== null ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={badge.variant} size="sm">
              {badge.label}
            </Badge>
            <span className="truncate text-xs text-muted-foreground">{meta}</span>
          </div>
          {check.lastSummary ? (
            <p className="line-clamp-3 text-xs text-muted-foreground">{check.lastSummary}</p>
          ) : null}
          {check.threadId !== null ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: props.environmentId, threadId: check.threadId }}
              className="w-fit text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {copy.openSession}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
