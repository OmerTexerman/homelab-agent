import type {
  EnvironmentId,
  HomelabSecretDelivery,
  HomelabSecretDescriptor,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import {
  brokerPolicyDraftChanged,
  brokerPolicyDraftFromSecret,
  parseAllowedHostsInput,
  validateBrokerPolicyDraft,
  type BrokerPolicyDraft,
  type BrokerPolicyValidation,
} from "~/homelab/egressBroker";
import { describeHomelabError } from "~/homelab/homelabFetch";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
import { homelabEgressQueryKeys } from "~/lib/homelabEgressReactQuery";
import {
  homelabSecretsQueryKeys,
  setHomelabSecretBrokerPolicyRequest,
} from "~/lib/homelabSecretsReactQuery";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

const DELIVERY_OPTIONS: ReadonlyArray<{
  readonly value: HomelabSecretDelivery;
  readonly title: string;
  readonly description: string;
}> = [
  {
    value: "file",
    title: "File",
    description: "The agent sees the value.",
  },
  {
    value: "brokered",
    title: "Brokered",
    description:
      "The agent gets a stand-in; the server injects the real value only for allowed hosts.",
  },
];

/**
 * The delivery choice and, for brokered delivery, allowed hosts, write
 * approvals, and TLS verification. Controlled; used by the add-secret form and
 * by each stored secret's policy editor.
 */
export function BrokerPolicyFields(props: {
  readonly idPrefix: string;
  readonly draft: BrokerPolicyDraft;
  readonly disabled?: boolean;
  readonly onChange: (draft: BrokerPolicyDraft) => void;
}) {
  const { draft, onChange, idPrefix } = props;
  const disabled = props.disabled ?? false;
  const hostErrors = useMemo(
    () => parseAllowedHostsInput(draft.allowedHostsText).errors,
    [draft.allowedHostsText],
  );
  const hostsId = `${idPrefix}-allowed-hosts`;
  const hostsErrorId = `${idPrefix}-allowed-hosts-errors`;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span id={`${idPrefix}-delivery-label`} className="text-xs font-medium text-foreground">
          Delivery
        </span>
        <RadioGroup
          aria-labelledby={`${idPrefix}-delivery-label`}
          value={draft.delivery}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "file" || value === "brokered") onChange({ ...draft, delivery: value });
          }}
          className="grid sm:grid-cols-2"
        >
          {DELIVERY_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 px-3 py-2.5"
            >
              <Radio value={option.value} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">{option.title}</span>
                <span className="block text-2xs leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>

      {draft.delivery === "brokered" ? (
        <div className="space-y-3">
          <label className="block space-y-1.5" htmlFor={hostsId}>
            <span className="text-xs font-medium text-foreground">Allowed hosts</span>
            <Textarea
              id={hostsId}
              size="sm"
              value={draft.allowedHostsText}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, allowedHostsText: event.target.value })}
              placeholder={"pve.lan:8006\n192.168.1.20\n*.example.com"}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={hostErrors.length > 0 || undefined}
              aria-describedby={hostErrors.length > 0 ? hostsErrorId : undefined}
            />
            <span className="block text-2xs text-muted-foreground">
              One per line. A hostname or IP address, optionally with a port;{" "}
              <code>*.example.com</code> covers every subdomain. No scheme or path.
            </span>
          </label>
          {hostErrors.length > 0 ? (
            <ul id={hostsErrorId} className="space-y-0.5 text-2xs text-destructive">
              {hostErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          <PolicySwitch
            title="Ask me before writes (POST/PUT/PATCH/DELETE)"
            description="Requests that change something wait up to five minutes for you to approve or deny them."
            checked={draft.approveWrites}
            disabled={disabled}
            onCheckedChange={(approveWrites) => onChange({ ...draft, approveWrites })}
          />
          <PolicySwitch
            title="Skip TLS verification for these hosts (self-signed)"
            description="Only for services with self-signed certificates."
            checked={draft.upstreamTls === "insecure"}
            disabled={disabled}
            onCheckedChange={(insecure) =>
              onChange({ ...draft, upstreamTls: insecure ? "insecure" : "verify" })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/** Policy-level validation messages; per-host ones render inside `BrokerPolicyFields`. */
export function BrokerPolicyFormErrors(props: { readonly validation: BrokerPolicyValidation }) {
  const { validation } = props;
  if (validation.ok || validation.formErrors.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-2xs text-destructive">
      {validation.formErrors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  );
}

function PolicySwitch(props: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{props.title}</span>
        <span className="block text-2xs leading-relaxed text-muted-foreground">
          {props.description}
        </span>
      </span>
      <Switch
        size="sm"
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(checked) => props.onCheckedChange(Boolean(checked))}
      />
    </label>
  );
}

/**
 * Edits a stored secret's broker policy in place, without its value. Saves
 * through `broker-policy`; the server's rejection message stays visible next
 * to the form as well as in the error toast.
 */
export function SecretBrokerPolicyEditor(props: {
  readonly secret: HomelabSecretDescriptor;
  readonly environmentId: EnvironmentId | null;
  readonly onDone: () => void;
}) {
  const { secret, environmentId, onDone } = props;
  const [draft, setDraft] = useState(() => brokerPolicyDraftFromSecret(secret));
  const [serverError, setServerError] = useState<string | null>(null);
  const validation = validateBrokerPolicyDraft(draft);
  const changed = brokerPolicyDraftChanged(secret, draft);

  const policyMutation = useHomelabMutation({
    mutationFn: async (policy: Extract<BrokerPolicyValidation, { ok: true }>["policy"]) => {
      if (!environmentId) {
        throw new Error("No environment is available to change secrets.");
      }
      return setHomelabSecretBrokerPolicyRequest({ environmentId, key: secret.key, ...policy });
    },
    invalidate: [homelabSecretsQueryKeys.all, homelabEgressQueryKeys.all],
    onSuccess: onDone,
    onError: (error) => setServerError(describeHomelabError(error)),
    successToast: (saved) => ({
      title: `Updated ${saved.placeholder}`,
      description:
        saved.delivery === "brokered"
          ? "Runtimes now get a stand-in; the real value goes only to the allowed hosts."
          : "Runtimes now get the real value.",
    }),
    errorToast: "Could not change how the secret is delivered",
  });

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <BrokerPolicyFields
        idPrefix={`secret-policy-${secret.key}`}
        draft={draft}
        disabled={policyMutation.isPending}
        onChange={(next) => {
          setServerError(null);
          setDraft(next);
        }}
      />
      <BrokerPolicyFormErrors validation={validation} />
      {serverError ? <p className="text-2xs text-destructive">{serverError}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!validation.ok || !changed || policyMutation.isPending}
          onClick={() => {
            if (validation.ok) policyMutation.submit(validation.policy);
          }}
        >
          {policyMutation.isPending ? "Saving..." : "Save delivery"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={policyMutation.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
