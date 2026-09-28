import { describe, expect, it, vi } from "vite-plus/test";

import { HomelabHttpError } from "./homelabFetch";
import {
  createSubmitGuard,
  runHomelabMutation,
  type HomelabMutationEffects,
} from "./homelabMutationCore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recordingEffects() {
  const events: string[] = [];
  const toasts: Array<{ type: string; title: string; description?: string | undefined }> = [];
  const effects: HomelabMutationEffects = {
    invalidate: async (queryKey) => {
      events.push(`invalidate:${queryKey.join("/")}`);
    },
    toast: (toast) => {
      events.push(`toast:${toast.type}`);
      toasts.push(toast);
    },
  };
  return { events, toasts, effects };
}

describe("runHomelabMutation", () => {
  it("does not toast success until the server confirms, then invalidates first", async () => {
    const server = deferred<{ placeholder: string }>();
    const { events, toasts, effects } = recordingEffects();
    const onSuccess = vi.fn(() => {
      events.push("onSuccess");
    });

    const run = runHomelabMutation(
      {
        mutationFn: () => server.promise,
        invalidate: [["homelabSecrets"]],
        onSuccess,
        successToast: (data) => ({ title: `Saved ${data.placeholder}` }),
      },
      effects,
      undefined,
    );

    await Promise.resolve();
    expect(toasts).toEqual([]);
    expect(onSuccess).not.toHaveBeenCalled();

    server.resolve({ placeholder: "$API_KEY" });
    await expect(run).resolves.toEqual({ placeholder: "$API_KEY" });
    expect(events).toEqual(["invalidate:homelabSecrets", "onSuccess", "toast:success"]);
    expect(toasts[0]).toEqual({ type: "success", title: "Saved $API_KEY" });
  });

  it("toasts the described server error, skips invalidation, and rethrows", async () => {
    const { events, toasts, effects } = recordingEffects();
    const failure = new HomelabHttpError({
      status: 400,
      reason: "invalid",
      message: "Invalid homelab secret key.",
      hasServerMessage: true,
    });
    const onError = vi.fn();

    await expect(
      runHomelabMutation(
        {
          mutationFn: () => Promise.reject(failure),
          invalidate: [["homelabSecrets"]],
          successToast: { title: "Saved" },
          errorToast: "Could not save secret",
          onError,
        },
        effects,
        undefined,
      ),
    ).rejects.toBe(failure);

    expect(onError).toHaveBeenCalledWith(failure, undefined);
    expect(events).toEqual(["toast:error"]);
    expect(toasts[0]).toEqual({
      type: "error",
      title: "Could not save secret",
      description: "Invalid homelab secret key.",
    });
  });
});

describe("createSubmitGuard", () => {
  it("ignores a second submit while the first is pending", async () => {
    const guard = createSubmitGuard();
    const server = deferred<void>();
    const task = vi.fn(() => server.promise);

    expect(guard.run(task)).toBe(true);
    expect(guard.run(task)).toBe(false);
    expect(task).toHaveBeenCalledTimes(1);
    expect(guard.isInFlight()).toBe(true);

    server.resolve();
    await server.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(guard.isInFlight()).toBe(false);
    expect(guard.run(task)).toBe(true);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("releases after a failed submit so the user can retry", async () => {
    const guard = createSubmitGuard();
    const server = deferred<void>();

    guard.run(() => server.promise);
    server.reject(new Error("boom"));
    await server.promise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(guard.isInFlight()).toBe(false);
  });
});
