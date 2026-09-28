/**
 * What a panel backed by a query should render. Kept structural so it works for
 * any TanStack `useQuery` result without importing the library.
 */
export type QueryDisplayState = "loading" | "error" | "empty" | "ready";

export interface QueryDisplayInput<T> {
  readonly status: "pending" | "error" | "success";
  readonly data: T | undefined;
}

/**
 * Maps a query to the state a panel should show. "loading" until the first
 * result arrives (never "empty"), "error" when it failed with nothing to show,
 * and "empty"/"ready" by `isEmpty` once data exists. A background refetch that
 * fails while older data is present keeps showing that data.
 *
 * A disabled query with no data reads as "loading", so gate disabled panels
 * before calling this.
 */
export function queryDisplayState<T>(
  query: QueryDisplayInput<T>,
  isEmpty: (data: T) => boolean,
): QueryDisplayState {
  if (query.data !== undefined) {
    return isEmpty(query.data) ? "empty" : "ready";
  }
  return query.status === "error" ? "error" : "loading";
}

/**
 * `placeholderData` that keeps the previous result only while the first
 * `scopeLength` query-key parts (the entity: environment, project, thread, path)
 * are unchanged. Use it for filters/search within one entity; switching project
 * or thread falls back to a real loading state instead of showing the old data
 * as if it were current.
 */
export function keepPreviousDataWithinScope(queryKey: ReadonlyArray<unknown>, scopeLength: number) {
  return <T>(
    previousData: T | undefined,
    previousQuery: { readonly queryKey: ReadonlyArray<unknown> } | undefined,
  ): T | undefined => {
    if (previousData === undefined || previousQuery === undefined) {
      return undefined;
    }
    for (let index = 0; index < scopeLength; index += 1) {
      if (!Object.is(previousQuery.queryKey[index], queryKey[index])) {
        return undefined;
      }
    }
    return previousData;
  };
}
