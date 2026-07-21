import { ProviderDriverKind } from "@t3tools/contracts";

export {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  derivePhase,
  deriveTimelineEntries,
  hasToolActivityForTurn,
  inferCheckpointTurnCountByTurnId,
  isLatestTurnSettled,
} from "./threadTimeline";
export type { TimelineEntry } from "./threadTimeline";

export {
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  formatDuration,
  formatElapsed,
  hasActionableProposedPlan,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "./threadActivityDerivations";
export type {
  ActivePlanState,
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
  WorkLogEntry,
  WorkLogToolLifecycleStatus,
} from "./threadActivityDerivations";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  // Homelab runtime images only ship the providers pinned in
  // docker/runtime/provider-versions.json; Cursor and Grok CLIs are not installed.
  { value: ProviderDriverKind.make("cursor"), label: "Cursor", available: false },
  { value: ProviderDriverKind.make("grok"), label: "Grok", available: false },
];
