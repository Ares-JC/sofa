import { useQuery } from "@tanstack/react-query";
import { createContext, use } from "react";

import { useSession } from "@/lib/auth/client";
import { orpc } from "@/lib/orpc/client";
import type { Season } from "@sofa/api/schemas";

interface TitleContextValue {
  titleId: string;
  titleType: "movie" | "tv";
  titleName: string;
  seasons: Season[];
  setSeasons: (seasons: Season[]) => void;
  watchingEp: string | null;
  setWatchingEp: (id: string | null) => void;
}

export const TitleContext = createContext<TitleContextValue | null>(null);

export function useTitleContext() {
  const ctx = use(TitleContext);
  if (!ctx) throw new Error("useTitleContext must be used within TitleProvider");
  return ctx;
}

export function useTitleUserInfo() {
  const { titleId } = useTitleContext();
  const { data: session } = useSession();
  const { data } = useQuery({
    ...orpc.tracking.userInfo.queryOptions({ input: { id: titleId } }),
    enabled: !!session,
    // Always re-check when a title page opens: the status may have changed from a list (hold to
    // mark watched, a collection, Plex/Jellyfin…) while an older copy was still cached
    refetchOnMount: "always",
  });
  return {
    userStatus: data?.status ?? null,
    userRating: data?.rating ?? 0,
    episodeWatches: data?.episodeWatches ?? [],
  };
}
