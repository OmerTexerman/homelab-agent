import { ServerIcon } from "lucide-react";

// Fork-owned brand mark shared by the classic sidebar chrome (Sidebar.tsx)
// and the beta SidebarV2 chrome (SidebarChrome.tsx). Replaces upstream's
// T3Wordmark; keep the rebrand localized here so upstream chrome files only
// need a one-line swap during syncs.
export function HomelabAgentMark() {
  return (
    <span
      aria-label="Homelab Agent"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground"
    >
      <ServerIcon className="size-3.5" />
    </span>
  );
}
