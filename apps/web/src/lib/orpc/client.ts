import { msg } from "@lingui/core/macro";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { contract } from "@sofa/api/contract";
import { i18n } from "@sofa/i18n";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    onError: (_error, query) => {
      toast.error(i18n._(msg`Something went wrong…`), {
        action: {
          label: i18n._(msg`Retry`),
          onClick: () => void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true }),
        },
      });
    },
  }),
});

/** Requests that can legitimately run long (file imports, backups) aren't timed out. */
const LONG_RUNNING_PATH = /\/(imports?|backups?|restore|admin)\b/i;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Give up on a request the server never answers (e.g. a dropped Tailscale connection), so the
 * page shows an error with Retry instead of loading forever.
 */
function withTimeout(url: string | URL | Request, signal: AbortSignal | null | undefined) {
  const path = typeof url === "string" ? url : url instanceof URL ? url.pathname : url.url;
  if (LONG_RUNNING_PATH.test(path) || typeof AbortSignal.timeout !== "function") {
    return signal ?? undefined;
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

export const link = new RPCLink({
  // No `origin`: in the browser the link uses the current origin.
  url: "/rpc",
  fetch: (url, init) =>
    fetch(url, { ...init, credentials: "include", signal: withTimeout(url, init?.signal) }),
});

export const client: RouterContractClient<typeof contract> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
