import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ProjectId } from "@t3tools/contracts";

import {
  declineHomelabSecretRequest,
  homelabSecretsQueryKeys,
  homelabSecretsQueryOptions,
  upsertHomelabSecretRequest,
} from "~/lib/homelabSecretsReactQuery";
import { deriveDecisionQueueReadModel } from "~/decisionQueueReadModel";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
import { useProject, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

const SECRET_REQUEST_POLL_INTERVAL_MS = 10_000;
const PENDING_SECRET_POLL_INTERVAL_MS = 3_000;

export function HomelabSecretRequestCoordinator() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handledKeysRef = useRef(new Set<string>());
  const [activeSecretKey, setActiveSecretKey] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const secretsQuery = useQuery({
    ...homelabSecretsQueryOptions({ environmentId: primaryEnvironmentId }),
    // Agents request secrets mid-turn, so poll for new requests, faster while one
    // is waiting. Hidden tabs don't poll; they refetch when focused again.
    refetchInterval: (query) =>
      query.state.data?.secrets.some((secret) => secret.pending)
        ? PENDING_SECRET_POLL_INTERVAL_MS
        : SECRET_REQUEST_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const activeSecret = useMemo(
    () => secretsQuery.data?.secrets.find((secret) => secret.key === activeSecretKey) ?? null,
    [activeSecretKey, secretsQuery.data?.secrets],
  );

  useEffect(() => {
    if (activeSecretKey !== null) {
      return;
    }

    const secretDecisionQueue = deriveDecisionQueueReadModel({
      secretRequests: {
        secrets: secretsQuery.data?.secrets,
        dismissedSecretKeys: handledKeysRef.current,
      },
    });
    const nextDecision = secretDecisionQueue.activeDecision;
    if (nextDecision?.kind !== "secret-request") {
      return;
    }

    setValue("");
    setActiveSecretKey(nextDecision.secret.key);
  }, [activeSecretKey, secretsQuery.data?.secrets]);

  const closeModal = (secretKey: string | null) => {
    if (secretKey) {
      handledKeysRef.current.add(secretKey);
    }
    setActiveSecretKey(null);
    setValue("");
  };

  // Which thread (and project) asked, when the server recorded it.
  const requesterRef = useMemo(
    () =>
      primaryEnvironmentId && activeSecret?.requestedByThreadId
        ? { environmentId: primaryEnvironmentId, threadId: activeSecret.requestedByThreadId }
        : null,
    [activeSecret?.requestedByThreadId, primaryEnvironmentId],
  );
  const requesterThread = useThreadShell(requesterRef);
  const requesterProjectRef = useMemo(
    () =>
      primaryEnvironmentId && requesterThread
        ? { environmentId: primaryEnvironmentId, projectId: requesterThread.projectId }
        : null,
    [primaryEnvironmentId, requesterThread],
  );
  const requesterProject = useProject(requesterProjectRef);
  // A secret limited to other projects would never reach the asking runtime,
  // so saving from this prompt also grants it to the asking project.
  const scopeGrant: ReadonlyArray<ProjectId> | undefined =
    activeSecret?.projectIds &&
    activeSecret.projectIds.length > 0 &&
    requesterProject &&
    !activeSecret.projectIds.includes(requesterProject.id)
      ? [...activeSecret.projectIds, requesterProject.id]
      : undefined;

  const saveSecretMutation = useHomelabMutation({
    mutationFn: async (secret: {
      key: string;
      value: string;
      label?: string;
      summary?: string;
      projectIds?: ReadonlyArray<ProjectId>;
    }) => {
      if (!primaryEnvironmentId) {
        throw new Error("No environment is available to store secrets.");
      }
      return upsertHomelabSecretRequest({ environmentId: primaryEnvironmentId, secret });
    },
    invalidate: [homelabSecretsQueryKeys.all],
    onSuccess: (_, secret) => closeModal(secret.key),
    successToast: (saved) => ({
      title: "Secret saved",
      description: `${saved.placeholder} is saved. Runtimes pick it up on their next command.`,
    }),
    errorToast: "Could not save secret",
  });
  const declineSecretMutation = useHomelabMutation({
    mutationFn: async (secretKey: string) => {
      if (!primaryEnvironmentId) {
        throw new Error("No environment is available to answer secret requests.");
      }
      return declineHomelabSecretRequest({ environmentId: primaryEnvironmentId, key: secretKey });
    },
    invalidate: [homelabSecretsQueryKeys.all],
    onSuccess: (_, secretKey) => closeModal(secretKey),
    successToast: (declined) => ({
      title: "Request declined",
      description: `The agent waiting for ${declined.placeholder} was told you declined.`,
    }),
    errorToast: "Could not decline the request",
  });
  const isSaving = saveSecretMutation.isPending || declineSecretMutation.isPending;

  if (!activeSecret) {
    return null;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeModal(activeSecret.key);
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <KeyRoundIcon className="size-5" />
            <DialogTitle>Secret requested</DialogTitle>
          </div>
          <DialogDescription>
            An agent asked for a secret value. The raw value stays in the secret registry and is
            delivered to runtimes as a file and an environment variable, not pasted into chat.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1 rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Placeholder
            </div>
            <div className="font-mono text-sm text-foreground">{activeSecret.placeholder}</div>
          </div>

          {activeSecret.label ? (
            <div className="space-y-1">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Label
              </div>
              <div className="text-sm text-foreground">{activeSecret.label}</div>
            </div>
          ) : null}

          {requesterThread ? (
            <div className="space-y-1">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Requested by
              </div>
              <div className="text-sm text-foreground">
                {requesterThread.title}
                {requesterProject ? (
                  <span className="text-muted-foreground"> in {requesterProject.title}</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {scopeGrant && requesterProject ? (
            <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              This secret is limited to other projects. Saving also makes it available to{" "}
              <span className="font-medium text-foreground">{requesterProject.title}</span>.
            </div>
          ) : null}

          {activeSecret.summary ? (
            <div className="space-y-1">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Why it was requested
              </div>
              <div className="text-sm leading-6 text-muted-foreground">{activeSecret.summary}</div>
            </div>
          ) : null}

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="homelab-secret-value">
              Secret value
            </label>
            <Input
              id="homelab-secret-value"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={`Enter ${activeSecret.key}`}
              autoFocus
            />
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="ghost"
            onClick={() => declineSecretMutation.submit(activeSecret.key)}
            disabled={isSaving || !activeSecret.pending}
          >
            Decline
          </Button>
          <Button
            variant="outline"
            onClick={() => closeModal(activeSecret.key)}
            disabled={isSaving}
          >
            Later
          </Button>
          <Button
            disabled={value.trim().length === 0 || isSaving}
            onClick={() => {
              saveSecretMutation.submit({
                key: activeSecret.key,
                value,
                ...(activeSecret.label ? { label: activeSecret.label } : {}),
                ...(activeSecret.summary ? { summary: activeSecret.summary } : {}),
                ...(scopeGrant ? { projectIds: scopeGrant } : {}),
              });
            }}
          >
            Save secret
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
