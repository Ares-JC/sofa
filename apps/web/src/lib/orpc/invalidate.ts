import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { trackingDerivedQueryKeys, trackingStateQueryKeys } from "@sofa/api/query-keys";

import { orpc } from "./client";

type TitleStatus = "in_watchlist" | "watching" | "caught_up" | "completed";

function sameKey(a: QueryKey, b: QueryKey) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Mark every query whose response depends on the user's tracking state
 * (statuses, watches, ratings, library membership) as stale. Active queries
 * refetch immediately; inactive ones refetch on next mount. Title details
 * (`titles.get`) are deliberately excluded — they don't depend on tracking.
 *
 * Explore lists (`discover.*`) are skipped: refetching them means re-downloading every loaded
 * page (dozens of TMDB requests on a long scroll) after each click. Their statuses are patched in
 * place with {@link patchExploreStatus} instead, and they refresh normally once stale.
 */
export function invalidateTrackingQueries(queryClient: QueryClient): Promise<unknown> {
  const discoverKey = orpc.discover.key();
  return Promise.all(
    [...trackingStateQueryKeys(orpc), ...trackingDerivedQueryKeys(orpc)]
      .filter((queryKey) => !sameKey(queryKey, discoverKey))
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

type StatusPage = { userStatuses?: Record<string, TitleStatus> };

function withStatus<T extends StatusPage>(page: T, titleId: string, status: TitleStatus | null): T {
  if (!page || typeof page !== "object" || !page.userStatuses) return page;
  const userStatuses = { ...page.userStatuses };
  if (status) userStatuses[titleId] = status;
  else delete userStatuses[titleId];
  return { ...page, userStatuses };
}

/** Update a title's status in every cached Explore list, without refetching them. */
export function patchExploreStatus(
  queryClient: QueryClient,
  titleId: string,
  status: TitleStatus | null,
) {
  queryClient.setQueriesData({ queryKey: orpc.discover.key() }, (data: unknown) => {
    if (!data || typeof data !== "object") return data;
    if ("pages" in data && Array.isArray((data as { pages: unknown[] }).pages)) {
      const infinite = data as { pages: StatusPage[] };
      return { ...infinite, pages: infinite.pages.map((p) => withStatus(p, titleId, status)) };
    }
    return withStatus(data as StatusPage, titleId, status);
  });
}
