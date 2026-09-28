import { describeHomelabError } from "./homelabFetch";

export interface HomelabToastContent {
  readonly title: string;
  readonly description?: string | undefined;
}

export interface HomelabMutationConfig<TData, TVariables> {
  readonly mutationFn: (variables: TVariables) => Promise<TData>;
  /** Query keys to invalidate (and wait on) after the server confirms the write. */
  readonly invalidate?: ReadonlyArray<ReadonlyArray<unknown>>;
  /** Shown only after the server confirms and invalidation settles. `null` skips it. */
  readonly successToast?:
    | HomelabToastContent
    | ((data: TData, variables: TVariables) => HomelabToastContent | null);
  /** Title for the failure toast. The description comes from `describeHomelabError`. */
  readonly errorToast?: string | ((error: unknown, variables: TVariables) => string);
  /** Runs after invalidation, before the success toast (e.g. reset a form). */
  readonly onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>;
  readonly onError?: (error: unknown, variables: TVariables) => void;
}

export interface HomelabMutationEffects {
  readonly invalidate: (queryKey: ReadonlyArray<unknown>) => Promise<unknown>;
  readonly toast: (toast: HomelabToastContent & { readonly type: "success" | "error" }) => void;
}

/**
 * Runs one homelab write: call the server, then invalidate, then `onSuccess`,
 * then the success toast. Nothing claims success before the server answers. On
 * failure it toasts the described error and rethrows so the caller's mutation
 * state reflects it.
 */
export async function runHomelabMutation<TData, TVariables>(
  config: HomelabMutationConfig<TData, TVariables>,
  effects: HomelabMutationEffects,
  variables: TVariables,
): Promise<TData> {
  let data: TData;
  try {
    data = await config.mutationFn(variables);
  } catch (error) {
    config.onError?.(error, variables);
    const title =
      typeof config.errorToast === "function"
        ? config.errorToast(error, variables)
        : (config.errorToast ?? "Could not save changes");
    effects.toast({ type: "error", title, description: describeHomelabError(error) });
    throw error;
  }

  await Promise.all((config.invalidate ?? []).map((queryKey) => effects.invalidate(queryKey)));
  await config.onSuccess?.(data, variables);
  const successToast =
    typeof config.successToast === "function"
      ? config.successToast(data, variables)
      : config.successToast;
  if (successToast) {
    effects.toast({ type: "success", ...successToast });
  }
  return data;
}

/**
 * Drops a submit while the previous one is still in flight. React state
 * (`isPending`) lags a synchronous double click, so the guard is a plain flag.
 */
export function createSubmitGuard() {
  let inFlight = false;
  return {
    isInFlight: () => inFlight,
    /** Starts `task` unless one is running. Returns false when the submit was ignored. */
    run(task: () => Promise<unknown>): boolean {
      if (inFlight) {
        return false;
      }
      inFlight = true;
      void task()
        .catch(() => {
          // Failures are already reported by runHomelabMutation.
        })
        .finally(() => {
          inFlight = false;
        });
      return true;
    },
  };
}
