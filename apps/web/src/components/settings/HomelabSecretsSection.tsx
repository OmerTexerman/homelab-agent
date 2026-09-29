import { AuthHomelabSecretsAdminScope } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { formatRelativeTime } from "~/timestampFormat";
import {
  deleteHomelabSecretRequest,
  homelabSecretsQueryKeys,
  homelabSecretsQueryOptions,
  upsertHomelabSecretRequest,
} from "~/lib/homelabSecretsReactQuery";
import { describeHomelabError } from "~/homelab/homelabFetch";
import { queryDisplayState } from "~/homelab/queryDisplayState";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
import { ensureLocalApi } from "~/localApi";
import { useScopeGate } from "~/homelab/useScopeGate";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ScopeRequiredNotice } from "../homelab/ScopeRequiredNotice";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

function normalizeOptionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function HomelabSecretsSection() {
  useRelativeTimeTick();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Writing secrets needs homelab:secrets-admin (server-enforced on the HTTP
  // routes). Gate the write UI on it too so a device paired without the scope
  // sees a read-only view instead of a 403 toast on save. The write UI stays
  // hidden until the session proves the scope; a failed session read denies.
  const secretsAdminGate = useScopeGate(AuthHomelabSecretsAdminScope);
  const canManageSecrets = secretsAdminGate === "granted";
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [value, setValue] = useState("");

  const secretsQuery = useQuery(
    homelabSecretsQueryOptions({ environmentId: primaryEnvironmentId }),
  );
  const secrets = secretsQuery.data?.secrets ?? [];
  const secretsDisplayState = queryDisplayState(secretsQuery, (data) => data.secrets.length === 0);

  const resetForm = useCallback(() => {
    setEditingKey(null);
    setKey("");
    setLabel("");
    setSummary("");
    setValue("");
  }, []);

  const upsertSecretMutation = useHomelabMutation({
    mutationFn: async (input: { key: string; label?: string; summary?: string; value: string }) => {
      if (!primaryEnvironmentId) {
        throw new Error("No environment is available to store secrets.");
      }
      return upsertHomelabSecretRequest({ environmentId: primaryEnvironmentId, secret: input });
    },
    invalidate: [homelabSecretsQueryKeys.all],
    onSuccess: resetForm,
    successToast: (secret) => ({
      title: `Saved ${secret.placeholder}`,
      description: "Runtimes pick it up on their next command.",
    }),
    errorToast: "Could not save secret",
  });

  const deleteSecretMutation = useHomelabMutation({
    mutationFn: async (secretKey: string) => {
      if (!primaryEnvironmentId) {
        throw new Error("No environment is available to remove secrets.");
      }
      return deleteHomelabSecretRequest({ environmentId: primaryEnvironmentId, key: secretKey });
    },
    invalidate: [homelabSecretsQueryKeys.all],
    onSuccess: (_, secretKey) => {
      if (editingKey === secretKey) {
        resetForm();
      }
    },
    successToast: (_, secretKey) => ({
      title: `Removed $${secretKey}`,
      description: "Future Project Runtime launches will no longer receive this secret.",
    }),
    errorToast: "Could not remove secret",
  });

  const isSaving = upsertSecretMutation.isPending;
  const deletingKey = deleteSecretMutation.variables ?? null;

  const canSubmit = useMemo(
    () => key.trim().length > 0 && value.length > 0 && !isSaving,
    [isSaving, key, value],
  );

  const handleSubmit = useCallback(() => {
    const normalizedKey = key.trim().toUpperCase();
    const normalizedLabel = normalizeOptionalValue(label);
    const normalizedSummary = normalizeOptionalValue(summary);
    if (normalizedKey.length === 0 || value.length === 0) {
      return;
    }

    const nextSecret: {
      key: string;
      value: string;
      label?: string;
      summary?: string;
    } = {
      key: normalizedKey,
      value,
    };
    if (normalizedLabel !== undefined) {
      nextSecret.label = normalizedLabel;
    }
    if (normalizedSummary !== undefined) {
      nextSecret.summary = normalizedSummary;
    }

    upsertSecretMutation.submit(nextSecret);
  }, [key, label, summary, upsertSecretMutation, value]);

  const handleEdit = useCallback((secret: (typeof secrets)[number]) => {
    setEditingKey(secret.key);
    setKey(secret.key);
    setLabel(secret.label ?? "");
    setSummary(secret.summary ?? "");
    setValue("");
  }, []);

  const handleDelete = useCallback(
    async (secretKey: string) => {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Delete $${secretKey}? Existing running threads may still have the value until they restart.`,
      );
      if (!confirmed) {
        return;
      }
      deleteSecretMutation.submit(secretKey);
    },
    [deleteSecretMutation],
  );

  return (
    <SettingsSection title="Secrets" icon={<KeyRoundIcon className="size-3.5" />}>
      <SettingsRow
        title="Runtime secrets"
        description="Store API keys, SSH tokens, and other values once, then inject them into every Project Runtime as environment variables."
        status="Agents and terminals receive these as env vars like $API_KEY. The raw values stay out of chat history."
      >
        {secretsAdminGate === "denied" ? (
          <ScopeRequiredNotice
            scope={AuthHomelabSecretsAdminScope}
            action="add, edit, or remove secrets"
            className="mt-4"
          />
        ) : null}
        <div
          className="mt-4 grid gap-3 border-t border-border/60 py-4 sm:grid-cols-2"
          hidden={!canManageSecrets}
        >
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Key</span>
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="API_KEY"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Label</span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="OpenAI API key"
              spellCheck={false}
            />
          </label>
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-foreground">Summary</span>
            <Input
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Used for service discovery, monitoring, or deployment tasks."
              spellCheck={false}
            />
          </label>
          <label className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium text-foreground">
              {editingKey ? "Replace value" : "Value"}
            </span>
            <Input
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                editingKey
                  ? "Enter a new value to replace the stored secret"
                  : "Paste the secret value"
              }
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              {isSaving ? "Saving..." : editingKey ? `Save $${editingKey}` : "Save secret"}
            </Button>
            {editingKey ? (
              <Button size="sm" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsRow>

      {secretsDisplayState === "loading" ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          Loading secrets...
        </div>
      ) : secretsDisplayState === "error" ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-destructive sm:px-5">
          Could not load secrets. {describeHomelabError(secretsQuery.error)}
        </div>
      ) : secretsDisplayState === "empty" ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          No secrets saved yet.
        </div>
      ) : (
        secrets.map((secret) => {
          const updatedRelative = formatRelativeTime(secret.updatedAt);
          return (
            <div
              key={secret.key}
              className="border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs font-medium text-foreground">
                      {secret.placeholder}
                    </code>
                    <span className="text-2xs text-muted-foreground">
                      {secret.label ?? secret.key}
                    </span>
                    <span className="rounded-full border border-border/70 px-2 py-0.5 text-3xs uppercase tracking-wider text-muted-foreground">
                      {secret.pending ? "Requested" : secret.hasValue ? "Stored" : "Missing"}
                    </span>
                  </div>
                  {secret.summary ? (
                    <p className="text-xs leading-relaxed text-muted-foreground/80">
                      {secret.summary}
                    </p>
                  ) : null}
                  {updatedRelative ? (
                    <p className="text-2xs text-muted-foreground">
                      Updated{" "}
                      {updatedRelative.suffix
                        ? `${updatedRelative.value} ${updatedRelative.suffix}`
                        : updatedRelative.value}
                    </p>
                  ) : null}
                </div>
                {canManageSecrets ? (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => handleEdit(secret)}>
                      <PencilIcon className="size-3.5" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={deleteSecretMutation.isPending}
                      onClick={() => void handleDelete(secret.key)}
                    >
                      <Trash2Icon className="size-3.5" />
                      {deleteSecretMutation.isPending && deletingKey === secret.key
                        ? "Removing..."
                        : "Delete"}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })
      )}
    </SettingsSection>
  );
}
