/**
 * The project page's Checks section: scheduled agent investigations of this
 * project, with their last result, and the editor to add or change one.
 * Each check runs as a new turn in its own thread ("Check: <name>").
 */
import type { EnvironmentId, ProjectCheck, ProjectId } from "@t3tools/contracts";
import { describeCheckSchedule } from "@t3tools/shared/projectCheckSchedule";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  CHECK_TEMPLATES,
  type CheckDraft,
  checkDraftFrom,
  checkDraftFromTemplate,
  checkInputFromDraft,
  checkStatusBadge,
  describeNextRun,
  EMPTY_CHECK_DRAFT,
  NOTIFY_POLICY_OPTIONS,
  type ScheduleKind,
  WEEKDAY_OPTIONS,
} from "../../homelab/projectChecks";
import { queryDisplayState } from "../../homelab/queryDisplayState";
import { useHomelabMutation } from "../../homelab/useHomelabMutation";
import {
  createHomelabCheckRequest,
  deleteHomelabCheckRequest,
  homelabChecksQueryKeys,
  homelabChecksQueryOptions,
  runHomelabCheckRequest,
  updateHomelabCheckRequest,
} from "../../lib/homelabChecksReactQuery";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { HomeSectionFrame, Placeholder } from "./HomelabHomeOverview";

const copy = {
  title: "Checks",
  addAction: "New check",
  empty: "No scheduled checks. Add one to have an agent look at this project on a schedule.",
  error: "Couldn't load checks.",
  runAction: "Run now",
  editAction: "Edit",
  deleteAction: "Delete",
  never: "Never run",
  nextRun: "Next",
  openThread: "Open thread",
  enabledLabel: "Run on schedule",
  createTitle: "New check",
  editTitle: "Edit check",
  editorDescription:
    "An agent runs the prompt in this project's runtime on the schedule, then reports ok, attention, or failed.",
  templatesLabel: "Start from",
  nameLabel: "Name",
  promptLabel: "What to check",
  promptPlaceholder: "What should the agent look at, and what counts as needing attention?",
  scheduleLabel: "Schedule",
  notifyLabel: "Notify",
  modelNote: "Runs with the project's default model.",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  deleteTitle: "Delete this check?",
  deleteDescription:
    "Its schedule and run history are removed. The check's thread stays, with every past run in it.",
  timeZoneNote: (timeZone: string) => `Times are in ${timeZone}.`,
} as const;

const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  interval: "Every…",
  daily: "Daily",
  weekly: "Weekly",
};

export function ProjectChecksSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  // The every-project list Home and the page's "Needs you" already poll, filtered here.
  const checksQuery = useQuery(homelabChecksQueryOptions({ environmentId: props.environmentId }));
  const checks = useMemo(
    () => (checksQuery.data?.checks ?? []).filter((check) => check.projectId === props.projectId),
    [checksQuery.data, props.projectId],
  );
  const timeZone = checksQuery.data?.timeZone ?? null;
  const state = queryDisplayState(checksQuery, () => checks.length === 0);
  const [editing, setEditing] = useState<ProjectCheck | "new" | null>(null);

  return (
    <HomeSectionFrame
      testId="project-checks"
      title={copy.title}
      total={checks.length}
      shown={checks.length}
      action={
        <Button variant="ghost" size="compact" onClick={() => setEditing("new")}>
          <PlusIcon className="size-3.5" />
          {copy.addAction}
        </Button>
      }
    >
      {state === "loading" ? (
        <div aria-busy="true" className="flex items-center gap-3 py-2">
          <span className="sr-only">Loading</span>
          <Placeholder className="h-4 flex-1" />
          <Placeholder className="h-3 w-10" />
        </div>
      ) : state === "error" ? (
        <p className="py-2 text-sm text-destructive">{copy.error}</p>
      ) : state === "empty" ? (
        <p className="py-2 text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        checks.map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            environmentId={props.environmentId}
            onEdit={() => setEditing(check)}
          />
        ))
      )}
      {editing !== null ? (
        <CheckEditorDialog
          environmentId={props.environmentId}
          projectId={props.projectId}
          check={editing === "new" ? null : editing}
          timeZone={timeZone}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </HomeSectionFrame>
  );
}

function CheckRow(props: {
  readonly check: ProjectCheck;
  readonly environmentId: EnvironmentId;
  readonly onEdit: () => void;
}) {
  const { check, environmentId } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const badge = checkStatusBadge(check);
  const invalidate = [homelabChecksQueryKeys.all];

  const toggle = useHomelabMutation({
    mutationFn: (enabled: boolean) =>
      updateHomelabCheckRequest({ environmentId, checkId: check.id, patch: { enabled } }),
    invalidate,
    errorToast: "Couldn't change the check",
  });
  const run = useHomelabMutation({
    mutationFn: () => runHomelabCheckRequest({ environmentId, checkId: check.id }),
    invalidate,
    successToast: { title: `Started ${check.name}` },
    errorToast: "Couldn't start the check",
  });
  const remove = useHomelabMutation({
    mutationFn: () => deleteHomelabCheckRequest({ environmentId, checkId: check.id }),
    invalidate,
    successToast: { title: `Deleted ${check.name}` },
    errorToast: "Couldn't delete the check",
    onSuccess: () => setConfirmDelete(false),
  });

  const meta = [
    describeCheckSchedule(check.schedule),
    check.lastRunAt ? formatRelativeTimeLabel(check.lastRunAt) : copy.never,
    check.nextRunAt ? `${copy.nextRun} ${describeNextRun(check.nextRunAt)}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div data-testid="project-check" className="flex min-w-0 flex-col gap-1.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{check.name}</span>
        <Badge variant={badge.variant} size="sm">
          {badge.label}
        </Badge>
        <span aria-hidden="true" className="flex-1" />
        <Switch
          size="sm"
          checked={check.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(enabled) => void toggle.submit(enabled)}
          aria-label={`${copy.enabledLabel}: ${check.name}`}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${copy.runAction}: ${check.name}`}
          disabled={check.running || run.isPending}
          onClick={() => void run.submit()}
        >
          <PlayIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${copy.editAction}: ${check.name}`}
          onClick={props.onEdit}
        >
          <PencilIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${copy.deleteAction}: ${check.name}`}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      <span className="truncate text-xs text-muted-foreground">{meta}</span>
      {check.lastSummary ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{check.lastSummary}</p>
      ) : null}
      {check.threadId !== null ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: check.threadId }}
          className="w-fit text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {copy.openThread}
        </Link>
      ) : null}
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!remove.isPending) setConfirmDelete(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={remove.isPending} render={<Button variant="outline" />}>
              {copy.cancel}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => void remove.submit()}
            >
              {copy.deleteAction}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function CheckEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly check: ProjectCheck | null;
  readonly timeZone: string | null;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<CheckDraft>(() =>
    props.check === null ? EMPTY_CHECK_DRAFT : checkDraftFrom(props.check),
  );
  const [showErrors, setShowErrors] = useState(false);
  const result = checkInputFromDraft(draft);
  const error = "error" in result ? result.error : null;
  const setSchedule = (patch: Partial<CheckDraft["schedule"]>) =>
    setDraft((current) => ({ ...current, schedule: { ...current.schedule, ...patch } }));

  const save = useHomelabMutation({
    mutationFn: () => {
      if ("error" in result) return Promise.reject(new Error(result.error));
      return props.check === null
        ? createHomelabCheckRequest({
            environmentId: props.environmentId,
            projectId: props.projectId,
            check: result.input,
          })
        : updateHomelabCheckRequest({
            environmentId: props.environmentId,
            checkId: props.check.id,
            patch: result.input,
          });
    },
    invalidate: [homelabChecksQueryKeys.all],
    successToast: { title: props.check === null ? "Check added" : "Check saved" },
    errorToast: "Couldn't save the check",
    onSuccess: props.onClose,
  });

  const submit = () => {
    if (error !== null) {
      setShowErrors(true);
      return;
    }
    void save.submit();
  };

  const schedule = draft.schedule;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.check === null ? copy.createTitle : copy.editTitle}</DialogTitle>
          <DialogDescription>{copy.editorDescription}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {props.check === null ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{copy.templatesLabel}</span>
                {CHECK_TEMPLATES.map((template) => (
                  <Button
                    key={template.id}
                    variant="outline"
                    size="xs"
                    onClick={() => setDraft((current) => checkDraftFromTemplate(current, template))}
                  >
                    {template.label}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="check-name">{copy.nameLabel}</Label>
              <Input
                id="check-name"
                value={draft.name}
                maxLength={120}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="check-prompt">{copy.promptLabel}</Label>
              <Textarea
                id="check-prompt"
                value={draft.prompt}
                rows={5}
                maxLength={8000}
                placeholder={copy.promptPlaceholder}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{copy.scheduleLabel}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={schedule.kind}
                  items={SCHEDULE_KIND_LABELS}
                  onValueChange={(value) => {
                    if (value === "interval" || value === "daily" || value === "weekly") {
                      setSchedule({ kind: value });
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="w-28" aria-label={copy.scheduleLabel}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {(Object.keys(SCHEDULE_KIND_LABELS) as ScheduleKind[]).map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {SCHEDULE_KIND_LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {schedule.kind === "interval" ? (
                  <>
                    <Input
                      type="number"
                      size="sm"
                      className="w-20"
                      min={1}
                      value={schedule.every}
                      aria-label="Interval"
                      onChange={(event) => setSchedule({ every: event.target.value })}
                    />
                    <Select
                      value={schedule.unit}
                      items={{ minutes: "minutes", hours: "hours" }}
                      onValueChange={(value) => {
                        if (value === "minutes" || value === "hours") setSchedule({ unit: value });
                      }}
                    >
                      <SelectTrigger size="sm" className="w-28" aria-label="Interval unit">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="minutes">minutes</SelectItem>
                        <SelectItem value="hours">hours</SelectItem>
                      </SelectPopup>
                    </Select>
                  </>
                ) : (
                  <>
                    {schedule.kind === "weekly" ? (
                      <Select
                        value={String(schedule.weekday)}
                        items={Object.fromEntries(
                          WEEKDAY_OPTIONS.map((option) => [String(option.value), option.label]),
                        )}
                        onValueChange={(value) => {
                          if (typeof value === "string") setSchedule({ weekday: Number(value) });
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
                    ) : null}
                    <span className="text-sm text-muted-foreground">at</span>
                    <Input
                      type="time"
                      size="sm"
                      className="w-28"
                      value={schedule.time}
                      aria-label="Time"
                      onChange={(event) => setSchedule({ time: event.target.value })}
                    />
                  </>
                )}
              </div>
              {props.timeZone ? (
                <span className="text-xs text-muted-foreground">
                  {copy.timeZoneNote(props.timeZone)}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{copy.notifyLabel}</Label>
              <Select
                value={draft.notifyPolicy}
                items={Object.fromEntries(
                  NOTIFY_POLICY_OPTIONS.map((option) => [option.value, option.label]),
                )}
                onValueChange={(value) => {
                  const option = NOTIFY_POLICY_OPTIONS.find(
                    (candidate) => candidate.value === value,
                  );
                  if (option) setDraft({ ...draft, notifyPolicy: option.value });
                }}
              >
                <SelectTrigger size="sm" className="w-56" aria-label={copy.notifyLabel}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {NOTIFY_POLICY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <span className="text-xs text-muted-foreground">
                {NOTIFY_POLICY_OPTIONS.find((option) => option.value === draft.notifyPolicy)
                  ?.description ?? ""}{" "}
                {copy.modelNote}
              </span>
            </div>
            {showErrors && error !== null ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={props.onClose}>
            {copy.cancel}
          </Button>
          <Button disabled={save.isPending} onClick={submit}>
            {save.isPending ? copy.saving : copy.save}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
