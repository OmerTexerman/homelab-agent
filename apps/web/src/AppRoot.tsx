import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Homelab fork: several fork surfaces (secret requests, homelab knowledge,
// thread workspace, runtime CLI card) fetch through react-query; upstream
// dropped its provider when the router moved to atoms, so it lives here.
const appQueryClient = new QueryClient();

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <QueryClientProvider client={appQueryClient}>
        <RouterProvider router={router} />
        <PreviewAutomationHosts />
        <ElectronBrowserHost />
      </QueryClientProvider>
    </AppAtomRegistryProvider>
  );
}
