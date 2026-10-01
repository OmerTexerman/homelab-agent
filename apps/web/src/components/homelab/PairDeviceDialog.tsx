/**
 * One-click "Pair a device": a small dialog that creates a one-time pairing
 * link for this server and shows it as a QR code with a copy button. Opened
 * from the sidebar footer and the command palette (admin sessions only);
 * mounted once next to the command palette.
 *
 * It reuses the pairing-credential request Settings -> Connections uses, and
 * links to the page the browser is on, since the homelab web app is served by
 * the server itself. Connections still lists (and can revoke) the link.
 */
import { AuthAccessWriteScope, AuthAdministrativeScopes } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CopyIcon, QrCodeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { isElectron } from "../../env";
import { createServerPairingCredential, isLoopbackHostname } from "../../environments/primary";
import { useScopeGate } from "../../homelab/useScopeGate";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import { formatExpiresInLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { toastManager } from "../ui/toast";

const usePairDeviceDialogStore = create<{ readonly open: boolean }>(() => ({ open: false }));

export function openPairDeviceDialog() {
  usePairDeviceDialogStore.setState({ open: true });
}

/** Whether this client can create pairing links from the quick dialog. */
export function useCanPairDevices(): boolean {
  const gate = useScopeGate(AuthAccessWriteScope);
  // The desktop app pairs through Settings -> Connections, which knows its endpoints.
  return !isElectron && gate === "granted";
}

export function PairDeviceDialog() {
  const open = usePairDeviceDialogStore((state) => state.open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) usePairDeviceDialogStore.setState({ open: false });
      }}
    >
      {open ? <PairDeviceDialogContent /> : null}
    </Dialog>
  );
}

type PairingLinkState =
  | { readonly status: "creating" }
  | { readonly status: "ready"; readonly url: string; readonly expiresAt: string }
  | { readonly status: "error"; readonly message: string };

function PairDeviceDialogContent() {
  const [fullAccess, setFullAccess] = useState(false);
  const [link, setLink] = useState<PairingLinkState>({ status: "creating" });
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "pairing link",
    onCopy: () =>
      toastManager.add({
        type: "success",
        title: "Pairing link copied",
        description: "Open it on the device you want to pair.",
      }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy pairing link",
        description: error.message,
      }),
  });

  // Each change of access level creates a fresh one-time link.
  useEffect(() => {
    let cancelled = false;
    setLink({ status: "creating" });
    createServerPairingCredential({
      label: fullAccess ? "Quick pair (full access)" : "Quick pair",
      ...(fullAccess ? { scopes: AuthAdministrativeScopes } : {}),
    }).then(
      (created) => {
        if (cancelled) return;
        const url = setPairingTokenOnUrl(
          new URL("/pair", window.location.href),
          created.credential,
        ).toString();
        setLink({ status: "ready", url, expiresAt: DateTime.formatIso(created.expiresAt) });
      },
      (error: unknown) => {
        if (cancelled) return;
        setLink({
          status: "error",
          message: error instanceof Error ? error.message : "Could not create a pairing link.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fullAccess]);

  const onLoopback = isLoopbackHostname(window.location.hostname);

  return (
    <DialogPopup className="max-w-sm">
      <DialogHeader>
        <DialogTitle>Pair a device</DialogTitle>
        <DialogDescription>
          Scan the code with the device's camera, or copy the link to it. The link works once.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col items-center gap-3">
          {link.status === "ready" ? (
            <>
              <div className="w-fit rounded-xl bg-white p-3">
                <QRCodeSvg
                  value={link.url}
                  size={200}
                  level="M"
                  marginSize={1}
                  title="Pairing link. Scan to open on another device"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {formatExpiresInLabel(link.expiresAt)}
              </p>
              {onLoopback ? (
                <p className="text-center text-xs text-warning">
                  This link points at localhost, so another device can't open it. Open this server
                  by its network name to pair other devices.
                </p>
              ) : null}
            </>
          ) : link.status === "creating" ? (
            <div className="flex size-[224px] items-center justify-center rounded-xl border border-border/60">
              <QrCodeIcon aria-hidden className="size-8 text-muted-foreground/60" />
            </div>
          ) : (
            <p className="text-sm text-destructive">{link.message}</p>
          )}
          <label className="flex items-center gap-2 self-start text-sm">
            <Checkbox
              checked={fullAccess}
              onCheckedChange={(checked) => setFullAccess(checked === true)}
            />
            Full access (can manage devices, passkeys, and secrets)
          </label>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => usePairDeviceDialogStore.setState({ open: false })}
        >
          Done
        </Button>
        <Button
          disabled={link.status !== "ready"}
          onClick={() => {
            if (link.status === "ready") copyToClipboard(link.url, undefined);
          }}
        >
          <CopyIcon aria-hidden />
          Copy link
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
