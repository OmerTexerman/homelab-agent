/**
 * Settings -> Devices & Sessions: passkeys for signing in to this server.
 * Rendered by upstream's `ConnectionsSettings` with one line. An admin session
 * (access:write) adds and removes passkeys; a sign-in with a passkey gets the
 * scopes of the session that added it. Hidden in the desktop app.
 */
import { AuthAccessWriteScope, type HomelabPasskey } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { describeHomelabError, isHomelabHttpError } from "~/homelab/homelabFetch";
import {
  isPasskeyPromptCancelled,
  isPasskeyUsableHere,
  listPasskeys,
  registerPasskey,
  removePasskey,
} from "~/homelab/passkeys";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
import { useScopeGate } from "~/homelab/useScopeGate";
import { ensureLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const passkeysQueryKey = ["homelab", "passkeys"] as const;

function describePasskeyError(error: unknown): string {
  if (error instanceof Error && error.name === "InvalidStateError") {
    return "This device already has a passkey for this server.";
  }
  if (!isHomelabHttpError(error) && error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return describeHomelabError(error);
}

function PasskeyRow(props: {
  readonly passkey: HomelabPasskey;
  readonly canManage: boolean;
  readonly isRemoving: boolean;
  readonly onRemove: (passkey: HomelabPasskey) => void;
}) {
  const { passkey } = props;
  const lastUsed = passkey.lastUsedAt ? formatRelativeTimeLabel(passkey.lastUsedAt) : "never";
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium text-foreground">{passkey.name}</p>
        <p className="text-xs text-muted-foreground">
          Added {formatRelativeTimeLabel(passkey.createdAt)} · Last used {lastUsed}
          {passkey.backedUp ? " · Synced" : ""}
        </p>
      </div>
      {props.canManage ? (
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={props.isRemoving}
          onClick={() => props.onRemove(passkey)}
        >
          <Trash2Icon aria-hidden />
          {props.isRemoving ? "Removing..." : "Remove"}
        </Button>
      ) : null}
    </div>
  );
}

export function HomelabPasskeysSection() {
  useRelativeTimeTick();
  const accessGate = useScopeGate(AuthAccessWriteScope);
  const canManage = accessGate === "granted";
  const usableHere = isPasskeyUsableHere();
  const [name, setName] = useState("");
  const passkeysQuery = useQuery({
    queryKey: passkeysQueryKey,
    queryFn: ({ signal }) => listPasskeys(signal),
    enabled: canManage && !isElectron,
  });

  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const removeMutation = useHomelabMutation({
    mutationFn: (id: string) => removePasskey(id),
    invalidate: [passkeysQueryKey],
    successToast: () => ({
      title: "Passkey removed",
      description: "Devices already signed in stay signed in; revoke them below if needed.",
    }),
    errorToast: "Could not remove passkey",
  });
  const [addError, setAddError] = useState("");

  if (isElectron || !canManage) return null;

  const passkeys = passkeysQuery.data ?? [];
  // Not a homelab mutation: a dismissed browser prompt is not a failure to toast.
  const handleAdd = async () => {
    if (isAdding) return;
    setIsAdding(true);
    setAddError("");
    const trimmed = name.trim();
    try {
      const passkey = await registerPasskey(trimmed.length > 0 ? trimmed.slice(0, 64) : undefined);
      setName("");
      await queryClient.invalidateQueries({ queryKey: passkeysQueryKey });
      toastManager.add({
        type: "success",
        title: `Added passkey "${passkey.name}"`,
        description: "Use it to sign in to this server from the pairing screen.",
      });
    } catch (error) {
      if (!isPasskeyPromptCancelled(error)) setAddError(describePasskeyError(error));
    } finally {
      setIsAdding(false);
    }
  };
  const handleRemove = async (passkey: HomelabPasskey) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove the passkey "${passkey.name}"? It can no longer be used to sign in. Devices already signed in with it stay signed in.`,
    );
    if (confirmed) removeMutation.submit(passkey.id);
  };

  return (
    <SettingsSection title="Passkeys" icon={<KeyRoundIcon className="size-3.5" />}>
      <SettingsRow
        title="Sign in with a passkey"
        description="Add a passkey on this device, then sign in from the pairing screen with Face ID, Touch ID, Windows Hello, or a security key instead of a pairing link. A passkey sign-in gets the same access as this session."
        status={
          usableHere
            ? undefined
            : "Passkeys need this server opened by its domain name over HTTPS (or localhost). Open it that way to add one."
        }
      >
        {usableHere ? (
          <div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center">
            <Input
              className="sm:max-w-xs"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name, for example MacBook Touch ID"
              maxLength={64}
              spellCheck={false}
            />
            <Button size="sm" disabled={isAdding} onClick={() => void handleAdd()}>
              <PlusIcon aria-hidden />
              {isAdding ? "Waiting for passkey..." : "Add passkey"}
            </Button>
          </div>
        ) : null}
        {addError ? <p className="mt-2 text-xs text-destructive">{addError}</p> : null}
      </SettingsRow>
      {passkeysQuery.isPending ? (
        <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          Loading passkeys...
        </div>
      ) : passkeysQuery.isError ? (
        <div className="border-t border-border/60 px-4 py-3 text-xs text-destructive sm:px-5">
          Could not load passkeys. {describeHomelabError(passkeysQuery.error)}
        </div>
      ) : passkeys.length === 0 ? (
        <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          No passkeys yet.
        </div>
      ) : (
        passkeys.map((passkey) => (
          <PasskeyRow
            key={passkey.id}
            passkey={passkey}
            canManage={canManage}
            isRemoving={removeMutation.isPending && removeMutation.variables === passkey.id}
            onRemove={(target) => void handleRemove(target)}
          />
        ))
      )}
    </SettingsSection>
  );
}
