import { AuthHomelabSecretsAdminScope, type ProjectId } from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import { useQuery } from "@tanstack/react-query";
import { FolderIcon, KeyRoundIcon, PencilIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { formatRelativeTime } from "~/timestampFormat";
import {
  deleteHomelabSecretRequest,
  homelabSecretsQueryKeys,
  homelabSecretsQueryOptions,
  setHomelabSecretScopeRequest,
  upsertHomelabSecretRequest,
} from "~/lib/homelabSecretsReactQuery";
import {
  DEFAULT_BROKER_POLICY_DRAFT,
  validateBrokerPolicyDraft,
  type BrokerPolicyDraft,
} from "~/homelab/egressBroker";
import { describeHomelabError } from "~/homelab/homelabFetch";
import { queryDisplayState } from "~/homelab/queryDisplayState";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
import { ensureLocalApi } from "~/localApi";
import { useScopeGate } from "~/homelab/useScopeGate";
import { usePrimarySessionState } from "../../environments/primary/sessionState";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ScopeRequiredNotice } from "../homelab/ScopeRequiredNotice";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { HomelabEgressActivity } from "./HomelabEgressActivity";
import {
  BrokerPolicyFields,
  BrokerPolicyFormErrors,
  SecretBrokerPolicyEditor,
} from "./HomelabSecretBrokerPolicy";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

function normalizeOptionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface ScopeProjectOption {
  readonly id: ProjectId;
  readonly title: string;
}

function describeScope(
  projectIds: ReadonlyArray<ProjectId>,
  projects: ReadonlyArray<ScopeProjectOption>,
): string {
  if (projectIds.length === 0) {
    return "All projects";
  }
  const titles = projectIds.map(
    (projectId) => projects.find((project) => project.id === projectId)?.title ?? "Removed project",
  );
  return titles.length <= 2 ? titles.join(", ") : `${titles.length} projects`;
}

/** One line under a brokered secret: where it may go and how. */
function describeBrokerPolicy(secret: {
  readonly allowedHosts?: ReadonlyArray<string> | undefined;
  readonly approveWrites?: boolean | undefined;
  readonly upstreamTls?: string | undefined;
}): string {
  const hosts = secret.allowedHosts ?? [];
  const shownHosts =
    hosts.length <= 3
      ? hosts.join(", ")
      : `${hosts.slice(0, 3).join(", ")} and ${hosts.length - 3} more`;
  return [
    hosts.length === 0 ? "No allowed hosts" : `Only to ${shownHosts}`,
    secret.approveWrites ? "asks before writes" : null,
    secret.upstreamTls === "insecure" ? "TLS not verified" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * Which projects' runtimes receive a secret. No selection means every runtime
 * (global); scratch and curator sessions only ever get global secrets.
 */
function SecretScopePicker(props: {
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly projects: ReadonlyArray<ScopeProjectOption>;
  readonly disabled?: boolean;
  readonly onChange: (projectIds: ReadonlyArray<ProjectId>) => void;
}) {
  const { projectIds, projects, onChange } = props;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="outline" disabled={props.disabled ?? false} />}
      >
        <FolderIcon className="size-3.5" />
        {describeScope(projectIds, projects)}
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <MenuCheckboxItem
          checked={projectIds.length === 0}
          onCheckedChange={(checked) => {
            if (checked) onChange([]);
          }}
        >
          All projects
        </MenuCheckboxItem>
        {projects.length > 0 ? <MenuSeparator /> : null}
        {projects.map((project) => (
          <MenuCheckboxItem
            key={project.id}
            checked={projectIds.includes(project.id)}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...projectIds, project.id]
                  : projectIds.filter((projectId) => projectId !== project.id),
              )
            }
          >
            {project.title}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
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
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>([]);
  const [brokerDraft, setBrokerDraft] = useState<BrokerPolicyDraft>(DEFAULT_BROKER_POLICY_DRAFT);
  const [policyEditingKey, setPolicyEditingKey] = useState<string | null>(null);
  const brokerValidation = useMemo(() => validateBrokerPolicyDraft(brokerDraft), [brokerDraft]);
  const allProjects = useProjects();
  const scopeProjects = useMemo(
    () =>
      allProjects
        .filter(
          (project) =>
            project.environmentId === primaryEnvironmentId &&
            !isStandaloneProjectId(project.id) &&
            !isCuratorProjectId(project.id),
        )
        .map((project) => ({ id: project.id, title: project.title }))
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, primaryEnvironmentId],
  );

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
    setProjectIds([]);
    setBrokerDraft(DEFAULT_BROKER_POLICY_DRAFT);
  }, []);

  const upsertSecretMutation = useHomelabMutation({
    mutationFn: async (input: {
      key: string;
      label?: string;
      summary?: string;
      value: string;
      projectIds?: ReadonlyArray<ProjectId>;
      delivery?: BrokerPolicyDraft["delivery"];
      allowedHosts?: ReadonlyArray<string>;
      approveWrites?: boolean;
      upstreamTls?: BrokerPolicyDraft["upstreamTls"];
    }) => {
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

  const scopeSecretMutation = useHomelabMutation({
    mutationFn: async (input: { key: string; projectIds: ReadonlyArray<ProjectId> }) => {
      if (!primaryEnvironmentId) {
        throw new Error("No environment is available to change secrets.");
      }
      return setHomelabSecretScopeRequest({ environmentId: primaryEnvironmentId, ...input });
    },
    invalidate: [homelabSecretsQueryKeys.all],
    successToast: (secret) => ({
      title: `Updated ${secret.placeholder}`,
      description:
        (secret.projectIds ?? []).length === 0
          ? "Every Project Runtime receives it."
          : "Only the selected projects' runtimes receive it.",
    }),
    errorToast: "Could not change the secret's projects",
  });

  const isSaving = upsertSecretMutation.isPending;
  const deletingKey = deleteSecretMutation.variables ?? null;

  const canSubmit = useMemo(
    () =>
      key.trim().length > 0 &&
      value.length > 0 &&
      !isSaving &&
      // A new secret's delivery is part of the form; an edit keeps the stored policy.
      (editingKey !== null || brokerValidation.ok),
    [brokerValidation.ok, editingKey, isSaving, key, value],
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
      projectIds?: ReadonlyArray<ProjectId>;
      delivery?: BrokerPolicyDraft["delivery"];
      allowedHosts?: ReadonlyArray<string>;
      approveWrites?: boolean;
      upstreamTls?: BrokerPolicyDraft["upstreamTls"];
    } = {
      key: normalizedKey,
      value,
    };
    // Editing an existing secret changes its scope and delivery from the row instead.
    if (editingKey === null) {
      if (!brokerValidation.ok) return;
      nextSecret.projectIds = projectIds;
      Object.assign(nextSecret, brokerValidation.policy);
    }
    if (normalizedLabel !== undefined) {
      nextSecret.label = normalizedLabel;
    }
    if (normalizedSummary !== undefined) {
      nextSecret.summary = normalizedSummary;
    }

    upsertSecretMutation.submit(nextSecret);
  }, [brokerValidation, editingKey, key, label, projectIds, summary, upsertSecretMutation, value]);

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
        description="Store API keys, SSH tokens, and other values once, then deliver them to every Project Runtime, or only to the projects you pick."
        status="Agents read them with `homelab secret get API_KEY`, and new shells also get env vars like $API_KEY. The raw values stay out of chat history."
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
          {editingKey ? null : (
            <>
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <span className="text-xs font-medium text-foreground">Available to</span>
                <SecretScopePicker
                  projectIds={projectIds}
                  projects={scopeProjects}
                  onChange={setProjectIds}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <BrokerPolicyFields
                  idPrefix="new-secret"
                  draft={brokerDraft}
                  disabled={isSaving}
                  onChange={setBrokerDraft}
                />
                <BrokerPolicyFormErrors validation={brokerValidation} />
              </div>
            </>
          )}
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
                      {secret.pending
                        ? "Requested"
                        : secret.declinedAt && !secret.hasValue
                          ? "Declined"
                          : secret.hasValue
                            ? "Stored"
                            : "Missing"}
                    </span>
                    {secret.delivery === "brokered" ? (
                      <Badge variant="info" size="sm">
                        Brokered
                      </Badge>
                    ) : null}
                  </div>
                  {secret.delivery === "brokered" ? (
                    <p className="text-2xs text-muted-foreground">{describeBrokerPolicy(secret)}</p>
                  ) : null}
                  {canManageSecrets ? null : (
                    <p className="text-2xs text-muted-foreground">
                      {describeScope(secret.projectIds ?? [], scopeProjects)}
                    </p>
                  )}
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
                  <div className="flex flex-wrap items-center gap-2">
                    <SecretScopePicker
                      projectIds={secret.projectIds ?? []}
                      projects={scopeProjects}
                      disabled={scopeSecretMutation.isPending}
                      onChange={(nextProjectIds) =>
                        scopeSecretMutation.submit({ key: secret.key, projectIds: nextProjectIds })
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={policyEditingKey === secret.key}
                      onClick={() =>
                        setPolicyEditingKey((current) =>
                          current === secret.key ? null : secret.key,
                        )
                      }
                    >
                      <ShieldCheckIcon className="size-3.5" />
                      Delivery
                    </Button>
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
              {canManageSecrets && policyEditingKey === secret.key ? (
                <SecretBrokerPolicyEditor
                  key={`${secret.key}:${secret.updatedAt}`}
                  secret={secret}
                  environmentId={primaryEnvironmentId}
                  onDone={() => setPolicyEditingKey(null)}
                />
              ) : null}
            </div>
          );
        })
      )}
      <HomelabEgressActivity />
    </SettingsSection>
  );
}
