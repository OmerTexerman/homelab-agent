import { createFileRoute } from "@tanstack/react-router";

import { SecretsSettingsPanel } from "../components/settings/HomelabSettingsPanels";

function SettingsSecretsRoute() {
  return <SecretsSettingsPanel />;
}

export const Route = createFileRoute("/settings/secrets")({
  component: SettingsSecretsRoute,
});
