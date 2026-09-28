import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { toastManager } from "~/components/ui/toast";

import {
  createSubmitGuard,
  runHomelabMutation,
  type HomelabMutationConfig,
  type HomelabMutationEffects,
} from "./homelabMutationCore";

export type { HomelabMutationConfig, HomelabToastContent } from "./homelabMutationCore";

/**
 * The shared pattern for homelab writes. Wraps `useMutation` so every write:
 * ignores a second submit while one is pending, toasts success only after the
 * server confirms (and the listed queries are invalidated), and toasts failures
 * with the server's message via `describeHomelabError`.
 *
 * Call `submit(variables)` from handlers; it returns false when ignored. The
 * rest of the `useMutation` result (`isPending`, `variables`, ...) is passed through.
 */
export function useHomelabMutation<TData, TVariables = void>(
  config: HomelabMutationConfig<TData, TVariables>,
) {
  const queryClient = useQueryClient();
  // Latest config without re-creating the mutation; handlers close over component state.
  const configRef = useRef(config);
  configRef.current = config;
  const guardRef = useRef<ReturnType<typeof createSubmitGuard> | null>(null);
  guardRef.current ??= createSubmitGuard();

  const mutation = useMutation<TData, unknown, TVariables>({
    mutationFn: (variables) => {
      const effects: HomelabMutationEffects = {
        invalidate: (queryKey) => queryClient.invalidateQueries({ queryKey }),
        toast: (toast) => {
          toastManager.add(toast);
        },
      };
      return runHomelabMutation(configRef.current, effects, variables);
    },
  });

  const { mutateAsync } = mutation;
  const submit = useCallback(
    (variables: TVariables) => guardRef.current!.run(() => mutateAsync(variables)),
    [mutateAsync],
  );

  return { ...mutation, submit };
}
