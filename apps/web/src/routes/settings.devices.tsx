import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsDevicesRoute() {
  return <ConnectionsSettings />;
}

export const Route = createFileRoute("/settings/devices")({
  component: SettingsDevicesRoute,
});
