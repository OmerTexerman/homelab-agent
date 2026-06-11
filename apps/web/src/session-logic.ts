import type { ProviderKind } from "@t3tools/contracts";

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
} from "./threadActivityDerivations";
export type {
  ActivePlanState,
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
  WorkLogEntry,
} from "./threadActivityDerivations";

export type ProviderPickerKind = ProviderKind | "cursor";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeAgent", label: "Claude", available: true },
  { value: "cursor", label: "Cursor", available: false },
];
