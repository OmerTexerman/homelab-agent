import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { AppRoot } from "./AppRoot";
import type { AppRouter } from "./router";

function childrenOf(element: ReactNode): ReactNode[] {
  return Children.toArray(
    (element as ReactElement<{ readonly children: ReactNode }>).props.children,
  );
}

describe("AppRoot (homelab)", () => {
  // Fork surfaces (secret requests, knowledge, thread workspace, runtime CLI
  // card) fetch through react-query; upstream has no provider of its own.
  it("wraps the routed UI in one app-wide QueryClientProvider", () => {
    const [queryProvider, ...rest] = childrenOf(AppRoot({ router: {} as AppRouter }));

    expect(rest).toHaveLength(0);
    expect(isValidElement(queryProvider) && queryProvider.type).toBe(QueryClientProvider);
    expect(
      childrenOf(queryProvider).some(
        (child) => isValidElement(child) && child.type === RouterProvider,
      ),
    ).toBe(true);
  });

  it("keeps the same query client across renders", () => {
    const clientOf = () =>
      (childrenOf(AppRoot({ router: {} as AppRouter }))[0] as ReactElement<{ client: unknown }>)
        .props.client;
    expect(clientOf()).toBe(clientOf());
  });
});
