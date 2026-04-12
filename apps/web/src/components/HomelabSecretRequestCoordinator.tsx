import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  homelabSecretsQueryKeys,
  homelabSecretsQueryOptions,
} from "~/lib/homelabSecretsReactQuery";
import { ensureLocalApi } from "~/localApi";
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
import { toastManager } from "./ui/toast";

export function HomelabSecretRequestCoordinator() {
  const queryClient = useQueryClient();
  const handledKeysRef = useRef(new Set<string>());
  const [activeSecretKey, setActiveSecretKey] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const secretsQuery = useQuery({
    ...homelabSecretsQueryOptions(),
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  });

  const activeSecret = useMemo(
    () => secretsQuery.data?.secrets.find((secret) => secret.key === activeSecretKey) ?? null,
    [activeSecretKey, secretsQuery.data?.secrets],
  );

  useEffect(() => {
    if (activeSecretKey !== null) {
      return;
    }

    const nextSecret =
      secretsQuery.data?.secrets.find(
        (secret) => !secret.hasValue && !handledKeysRef.current.has(secret.key),
      ) ?? null;
    if (!nextSecret) {
      return;
    }

    setValue("");
    setActiveSecretKey(nextSecret.key);
  }, [activeSecretKey, secretsQuery.data?.secrets]);

  const closeModal = (secretKey: string | null) => {
    if (secretKey) {
      handledKeysRef.current.add(secretKey);
    }
    setActiveSecretKey(null);
    setValue("");
    setIsSaving(false);
  };

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
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-5" />
            Secret requested
          </DialogTitle>
          <DialogDescription>
            An agent asked for a secret value. The raw value stays in the secret registry and gets
            injected into runtimes as an environment variable, not pasted into chat.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
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
              setIsSaving(true);
              void ensureLocalApi()
                .server.upsertHomelabSecret({
                  key: activeSecret.key,
                  value,
                  ...(activeSecret.label ? { label: activeSecret.label } : {}),
                  ...(activeSecret.summary ? { summary: activeSecret.summary } : {}),
                })
                .then(() =>
                  queryClient.invalidateQueries({
                    queryKey: homelabSecretsQueryKeys.all,
                  }),
                )
                .then(() => {
                  toastManager.add({
                    type: "success",
                    title: "Secret saved",
                    description: `${activeSecret.placeholder} is now available to runtimes.`,
                  });
                  closeModal(activeSecret.key);
                })
                .catch((error: unknown) => {
                  setIsSaving(false);
                  toastManager.add({
                    type: "error",
                    title: "Could not save secret",
                    description:
                      error instanceof Error ? error.message : "Unknown secret save failure.",
                  });
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
