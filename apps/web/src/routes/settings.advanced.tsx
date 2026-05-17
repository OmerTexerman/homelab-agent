import { createFileRoute } from "@tanstack/react-router";

import { AdvancedSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsAdvancedRoute() {
  return <AdvancedSettingsPanel />;
}

export const Route = createFileRoute("/settings/advanced")({
  component: SettingsAdvancedRoute,
});
