/**
 * Passkey (WebAuthn) sign-in and management against the primary environment's
 * `/api/homelab/passkeys/*` routes.
 *
 * Passkeys are bound to the host name the browser shows, so they only work
 * when the page and the API share one origin (the server serves the web app,
 * directly or behind a reverse proxy) on a domain or localhost over a secure
 * context. `isPasskeyUsableHere` checks all of that; the desktop app hides
 * passkeys because its window is not a web origin the passkey can bind to.
 */
import {
  isPasskeyCapableHostname,
  type AuthBrowserSessionResult,
  type HomelabPasskey,
  type HomelabPasskeyAvailability,
  type HomelabPasskeyCeremonyOptions,
  type HomelabPasskeyListResult,
  type HomelabPasskeyRemoveResult,
} from "@t3tools/contracts";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import { isElectron } from "../env";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { fetchHomelabJson } from "./homelabFetch";

function primaryUrl(pathname: `/api/homelab/passkeys${string}`): string {
  return resolvePrimaryEnvironmentHttpUrl(pathname);
}

/** Whether this browser, page, and server can use passkeys at all. */
export function isPasskeyUsableHere(): boolean {
  if (isElectron || typeof window === "undefined" || !window.isSecureContext) {
    return false;
  }
  if (typeof window.PublicKeyCredential === "undefined" || !browserSupportsWebAuthn()) {
    return false;
  }
  if (!isPasskeyCapableHostname(window.location.hostname)) {
    return false;
  }
  try {
    // The server checks the page origin against the API request's host.
    return new URL(primaryUrl("/api/homelab/passkeys")).origin === window.location.origin;
  } catch {
    return false;
  }
}

export async function fetchPasskeyAvailability(signal?: AbortSignal): Promise<boolean> {
  const result = await fetchHomelabJson<HomelabPasskeyAvailability>(
    primaryUrl("/api/homelab/passkeys/available"),
    signal ? { signal } : {},
  );
  return result.available;
}

export async function listPasskeys(signal?: AbortSignal): Promise<ReadonlyArray<HomelabPasskey>> {
  const result = await fetchHomelabJson<HomelabPasskeyListResult>(
    primaryUrl("/api/homelab/passkeys"),
    signal ? { signal } : {},
  );
  return result.passkeys;
}

export async function removePasskey(id: string): Promise<boolean> {
  const result = await fetchHomelabJson<HomelabPasskeyRemoveResult>(
    primaryUrl("/api/homelab/passkeys/remove"),
    { body: { id } },
  );
  return result.removed;
}

/** The user dismissed the browser's passkey prompt; not an error to report. */
export function isPasskeyPromptCancelled(error: unknown): boolean {
  return (
    (error instanceof WebAuthnError && error.code === "ERROR_CEREMONY_ABORTED") ||
    (error instanceof Error && error.name === "NotAllowedError")
  );
}

/** Registers a passkey on this device for the current (admin) session. */
export async function registerPasskey(name: string | undefined): Promise<HomelabPasskey> {
  const body = name ? { name } : {};
  const ceremony = await fetchHomelabJson<HomelabPasskeyCeremonyOptions>(
    primaryUrl("/api/homelab/passkeys/registration/options"),
    { body },
  );
  const response = await startRegistration({
    optionsJSON: ceremony.options as PublicKeyCredentialCreationOptionsJSON,
  });
  const result = await fetchHomelabJson<{ readonly passkey: HomelabPasskey }>(
    primaryUrl("/api/homelab/passkeys/registration/verify"),
    { body: { ...body, challengeId: ceremony.challengeId, response } },
  );
  return result.passkey;
}

/**
 * Signs in with a passkey the browser holds for this host. On success the
 * server has set the session cookie; the caller reloads into the app.
 */
export async function signInWithPasskey(): Promise<void> {
  const ceremony = await fetchHomelabJson<HomelabPasskeyCeremonyOptions>(
    primaryUrl("/api/homelab/passkeys/authentication/options"),
    { body: {} },
  );
  const response = await startAuthentication({
    optionsJSON: ceremony.options as PublicKeyCredentialRequestOptionsJSON,
  });
  await fetchHomelabJson<AuthBrowserSessionResult>(
    primaryUrl("/api/homelab/passkeys/authentication/verify"),
    { body: { challengeId: ceremony.challengeId, response } },
  );
}
