import { describe, expect, it } from "vitest";

import { keepPreviousDataWithinScope, queryDisplayState } from "./queryDisplayState";

const isEmptyList = (data: { readonly items: ReadonlyArray<string> }) => data.items.length === 0;

describe("queryDisplayState", () => {
  it("is loading, not empty, before the first result arrives", () => {
    expect(queryDisplayState({ status: "pending", data: undefined }, isEmptyList)).toBe("loading");
  });

  it("is error when the query failed with nothing to show", () => {
    expect(queryDisplayState({ status: "error", data: undefined }, isEmptyList)).toBe("error");
  });

  it("uses isEmpty once data exists", () => {
    expect(queryDisplayState({ status: "success", data: { items: [] } }, isEmptyList)).toBe(
      "empty",
    );
    expect(queryDisplayState({ status: "success", data: { items: ["a"] } }, isEmptyList)).toBe(
      "ready",
    );
  });

  it("keeps showing existing data when a background refetch fails", () => {
    expect(queryDisplayState({ status: "error", data: { items: ["a"] } }, isEmptyList)).toBe(
      "ready",
    );
  });
});

describe("keepPreviousDataWithinScope", () => {
  const previous = { items: ["old"] };

  it("keeps the previous data while the scoped key parts match", () => {
    const placeholder = keepPreviousDataWithinScope(["files", "env-1", "thread-1", "query-b"], 3);
    expect(placeholder(previous, { queryKey: ["files", "env-1", "thread-1", "query-a"] })).toBe(
      previous,
    );
  });

  it("drops the previous data when the entity changes", () => {
    const placeholder = keepPreviousDataWithinScope(["files", "env-1", "thread-2", "query-a"], 3);
    expect(
      placeholder(previous, { queryKey: ["files", "env-1", "thread-1", "query-a"] }),
    ).toBeUndefined();
  });

  it("has nothing to keep without a previous query", () => {
    const placeholder = keepPreviousDataWithinScope(["files", "env-1"], 2);
    expect(placeholder(undefined, undefined)).toBeUndefined();
  });
});
