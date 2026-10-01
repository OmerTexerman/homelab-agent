/**
 * "Sign in with passkey" at the top of the pairing screen, as its primary
 * action. Rendered by upstream's `PairingRouteSurface` with one line; renders
 * nothing unless this browser can use passkeys here and the server has one
 * registered for this host name.
 */
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { describeHomelabError } from "../../homelab/homelabFetch";
import {
  fetchPasskeyAvailability,
  isPasskeyPromptCancelled,
  isPasskeyUsableHere,
  signInWithPasskey,
} from "../../homelab/passkeys";
import { Button } from "../ui/button";

export function HomelabPasskeySignIn() {
  const [available, setAvailable] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!isPasskeyUsableHere()) return;
    const controller = new AbortController();
    fetchPasskeyAvailability(controller.signal).then(setAvailable, () => setAvailable(false));
    return () => controller.abort();
  }, []);

  if (!available) return null;

  const handleSignIn = async () => {
    setIsSigningIn(true);
    setErrorMessage("");
    try {
      await signInWithPasskey();
      // Hard reload so every session consumer starts from the new cookie.
      window.location.replace("/");
    } catch (error) {
      setIsSigningIn(false);
      if (!isPasskeyPromptCancelled(error)) {
        setErrorMessage(describeHomelabError(error));
      }
    }
  };

  return (
    <div className="mt-6 space-y-3 border-b border-border/60 pb-6">
      <Button disabled={isSigningIn} onClick={() => void handleSignIn()}>
        <KeyRoundIcon aria-hidden />
        {isSigningIn ? "Waiting for passkey..." : "Sign in with passkey"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Use a passkey you added in Settings on this server, for example with Face ID, Touch ID,
        Windows Hello, or a security key. No passkey on this device? Paste a pairing token below.
      </p>
      {errorMessage ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
