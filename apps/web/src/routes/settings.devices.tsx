import { createFileRoute, redirect } from "@tanstack/react-router";

// Homelab fork: "Devices & Sessions" used to live here. It is upstream's
// Connections page again; keep old links working.
export const Route = createFileRoute("/settings/devices")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/connections", replace: true });
  },
});
