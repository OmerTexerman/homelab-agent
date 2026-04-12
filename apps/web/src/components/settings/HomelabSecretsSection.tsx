import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { formatRelativeTime } from "~/timestampFormat";
import {
  homelabSecretsQueryKeys,
  homelabSecretsQueryOptions,
} from "~/lib/homelabSecretsReactQuery";
import { ensureLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

function normalizeOptionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function HomelabSecretsSection() {
  useRelativeTimeTick();
  const queryClient = useQueryClient();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [value, setValue] = useState("");

  const secretsQuery = useQuery(homelabSecretsQueryOptions());
  const secrets = secretsQuery.data?.secrets ?? [];

  const upsertSecretMutation = useMutation({
    mutationFn: async (input: { key: string; label?: string; summary?: string; value: string }) =>
      ensureLocalApi().server.upsertHomelabSecret(input),
    onSuccess: async (secret) => {
      await queryClient.invalidateQueries({ queryKey: homelabSecretsQueryKeys.all });
      setEditingKey(null);
      setKey("");
      setLabel("");
      setSummary("");
      setValue("");
      toastManager.add({
        type: "success",
        title: `Saved ${secret.placeholder}`,
        description: "This secret is now available to new and existing thread runtimes.",
      });
    },
    onError: (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not save secret",
        description: error instanceof Error ? error.message : "Secret save failed.",
      });
    },
  });

  const deleteSecretMutation = useMutation({
    mutationFn: async (secretKey: string) =>
      ensureLocalApi().server.deleteHomelabSecret({ key: secretKey }),
    onSuccess: async (_, secretKey) => {
      await queryClient.invalidateQueries({ queryKey: homelabSecretsQueryKeys.all });
      if (editingKey === secretKey) {
        setEditingKey(null);
        setKey("");
        setLabel("");
        setSummary("");
        setValue("");
      }
      toastManager.add({
        type: "success",
        title: `Removed $${secretKey}`,
        description: "Future thread launches will no longer receive this secret.",
      });
    },
    onError: (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not remove secret",
        description: error instanceof Error ? error.message : "Secret removal failed.",
      });
    },
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

    upsertSecretMutation.mutate(nextSecret);
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
      deleteSecretMutation.mutate(secretKey);
    },
    [deleteSecretMutation],
  );

  return (
    <SettingsSection title="Secrets" icon={<KeyRoundIcon className="size-3.5" />}>
      <SettingsRow
        title="Runtime secrets"
        description="Store API keys, SSH tokens, and other values once, then inject them into every thread runtime as environment variables."
        status="Agents and terminals receive these as env vars like $API_KEY. The raw values stay out of chat history."
      >
        <div className="mt-4 grid gap-3 border-t border-border/60 py-4 sm:grid-cols-2">
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingKey(null);
                  setKey("");
                  setLabel("");
                  setSummary("");
                  setValue("");
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsRow>

      {secretsQuery.isLoading ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          Loading secrets...
        </div>
      ) : secrets.length === 0 ? (
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
                    <span className="text-[11px] text-muted-foreground">
                      {secret.label ?? secret.key}
                    </span>
                    <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                      {secret.hasValue ? "Stored" : "Missing"}
                    </span>
                  </div>
                  {secret.summary ? (
                    <p className="text-xs leading-relaxed text-muted-foreground/80">
                      {secret.summary}
                    </p>
                  ) : null}
                  <p className="text-[11px] text-muted-foreground">
                    Updated{" "}
                    {updatedRelative.suffix
                      ? `${updatedRelative.value} ${updatedRelative.suffix}`
                      : updatedRelative.value}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => handleEdit(secret)}>
                    <PencilIcon className="size-3.5" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={deleteSecretMutation.isPending && deletingKey === secret.key}
                    onClick={() => void handleDelete(secret.key)}
                  >
                    <Trash2Icon className="size-3.5" />
                    {deleteSecretMutation.isPending && deletingKey === secret.key
                      ? "Removing..."
                      : "Delete"}
                  </Button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </SettingsSection>
  );
}
