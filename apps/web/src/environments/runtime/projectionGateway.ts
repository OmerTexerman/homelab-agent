import type { EnvironmentId, OrchestrationEvent, OrchestrationReadModel } from "@t3tools/contracts";

export type AppliedProjectionVersion = {
  readonly sequence: number;
  readonly updatedAt: string | null;
};

function compareAppliedProjectionVersion(
  left: AppliedProjectionVersion,
  right: AppliedProjectionVersion,
): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  const leftUpdatedAt = left.updatedAt ?? "";
  const rightUpdatedAt = right.updatedAt ?? "";
  if (leftUpdatedAt === rightUpdatedAt) {
    return 0;
  }

  return leftUpdatedAt < rightUpdatedAt ? -1 : 1;
}

function toAppliedProjectionVersion(
  snapshot: Pick<OrchestrationReadModel, "snapshotSequence" | "updatedAt">,
): AppliedProjectionVersion {
  return {
    sequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
  };
}

export function shouldApplyProjectionSnapshot(input: {
  readonly current: AppliedProjectionVersion | null;
  readonly next: Pick<OrchestrationReadModel, "snapshotSequence" | "updatedAt">;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return compareAppliedProjectionVersion(input.current, toAppliedProjectionVersion(input.next)) < 0;
}

export function shouldApplyProjectionEvent(input: {
  readonly current: AppliedProjectionVersion | null;
  readonly sequence: number;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return input.sequence > input.current.sequence;
}

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

export class EnvironmentProjectionGateway {
  private readonly lastAppliedVersionByEnvironment = new Map<
    EnvironmentId,
    AppliedProjectionVersion
  >();

  readVersion(environmentId: EnvironmentId): AppliedProjectionVersion | null {
    return this.lastAppliedVersionByEnvironment.get(environmentId) ?? null;
  }

  shouldApplySnapshot(
    environmentId: EnvironmentId,
    snapshot: Pick<OrchestrationReadModel, "snapshotSequence" | "updatedAt">,
  ): boolean {
    return shouldApplyProjectionSnapshot({
      current: this.readVersion(environmentId),
      next: snapshot,
    });
  }

  markSnapshotApplied(
    environmentId: EnvironmentId,
    snapshot: Pick<OrchestrationReadModel, "snapshotSequence" | "updatedAt">,
  ): void {
    const nextVersion = toAppliedProjectionVersion(snapshot);
    const currentVersion = this.readVersion(environmentId);
    if (
      currentVersion !== null &&
      compareAppliedProjectionVersion(currentVersion, nextVersion) >= 0
    ) {
      return;
    }

    this.lastAppliedVersionByEnvironment.set(environmentId, nextVersion);
  }

  markEventApplied(environmentId: EnvironmentId, sequence: number): void {
    const currentVersion = this.readVersion(environmentId);
    if (currentVersion !== null && sequence <= currentVersion.sequence) {
      return;
    }

    this.lastAppliedVersionByEnvironment.set(environmentId, {
      sequence,
      updatedAt: currentVersion?.updatedAt ?? null,
    });
  }

  filterApplicableEvents(
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
  ): OrchestrationEvent[] {
    const applicableEvents: OrchestrationEvent[] = [];
    let current = this.readVersion(environmentId);

    for (const event of events) {
      if (!shouldApplyProjectionEvent({ current, sequence: event.sequence })) {
        continue;
      }

      applicableEvents.push(event);
      current = {
        sequence: event.sequence,
        updatedAt: current?.updatedAt ?? null,
      };
    }

    return applicableEvents;
  }

  reset(environmentId: EnvironmentId): void {
    this.lastAppliedVersionByEnvironment.delete(environmentId);
  }

  resetAll(): void {
    this.lastAppliedVersionByEnvironment.clear();
  }
}
