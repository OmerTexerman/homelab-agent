import { queryOptions } from "@tanstack/react-query";

import { ensureLocalApi } from "~/localApi";

export const homelabSecretsQueryKeys = {
  all: ["homelabSecrets"] as const,
};

export function homelabSecretsQueryOptions() {
  return queryOptions({
    queryKey: homelabSecretsQueryKeys.all,
    queryFn: async () => ensureLocalApi().server.listHomelabSecrets(),
    staleTime: 5_000,
  });
}
