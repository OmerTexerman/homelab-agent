import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  homelabSecretsQueryKeys,
  homelabSecretsQueryOptions,
  upsertHomelabSecretRequest,
} from "~/lib/homelabSecretsReactQuery";
import { deriveDecisionQueueReadModel } from "~/decisionQueueReadModel";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
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

  const saveSecretMutation = useHomelabMutation({
    mutationFn: async (secret: {
      key: string;
      value: string;
      label?: string;
      summary?: string;
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
  const isSaving = saveSecretMutation.isPending;

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
            An agent asked for a secret value. The raw value stays in the secret registry and gets
            injected into runtimes as an environment variable, not pasted into chat.
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
