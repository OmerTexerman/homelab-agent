import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("shares the application atom registry and a query client with routed UI and desktop hosts", () => {
    const root = AppRoot({ router: {} as AppRouter });

    // AppAtomRegistryProvider wraps a QueryClientProvider (fork surfaces fetch
    // through react-query) which in turn holds the routed UI and desktop hosts.
    expect(root.type).toBe(AppAtomRegistryProvider);
    const registryChildren = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(registryChildren).toHaveLength(1);
    const queryProvider = registryChildren[0];
    expect(isValidElement(queryProvider) && queryProvider.type).toBe(QueryClientProvider);

    const children = Children.toArray(
      (queryProvider as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(children).toHaveLength(3);
    expect(isValidElement(children[0]) && children[0].type).toBe(RouterProvider);
    expect(isValidElement(children[1]) && children[1].type).toBe(PreviewAutomationHosts);
    expect(isValidElement(children[2]) && children[2].type).toBe(ElectronBrowserHost);
  });
});
