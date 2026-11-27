import { TitleCard, TitleCardSkeleton } from "@/components/title-card";
import { Skeleton } from "@/components/ui/skeleton";

interface TitleGridItem {
  id: string;
  type: string;
  title: string;
  posterPath: string | null;
  posterThumbHash?: string | null;
  releaseDate?: string | null;
  firstAirDate?: string | null;
  voteAverage?: number | null;
  isAnime?: boolean;
  userStatus?: "in_watchlist" | "watching" | "caught_up" | "completed" | null;
  episodeProgress?: { watched: number; total: number } | null;
}

export function TitleGridSectionSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Skeleton className="size-5 rounded" />
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        <TitleCardSkeleton />
        <TitleCardSkeleton />
        <TitleCardSkeleton />
        <TitleCardSkeleton />
        <TitleCardSkeleton />
      </div>
    </div>
  );
}

/** Cards per stagger wave: matches a page of results. */
const STAGGER_BATCH = 20;

export function TitleGrid({ items }: { items: TitleGridItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {items.map((t, i) => (
        <div
          key={t.id}
          className="animate-stagger-item"
          // Stagger within each batch of 20. Using the absolute index made the fade-in delay grow
          // with the list (card #300 waited 12 s), so deep in Explore new cards looked like they
          // never loaded.
          style={{ "--stagger-index": i % STAGGER_BATCH } as React.CSSProperties}
        >
          <TitleCard
            id={t.id}
            type={t.type}
            title={t.title}
            posterPath={t.posterPath}
            posterThumbHash={t.posterThumbHash}
            releaseDate={t.releaseDate ?? t.firstAirDate}
            voteAverage={t.voteAverage}
            isAnime={t.isAnime}
            userStatus={t.userStatus}
            episodeProgress={t.episodeProgress}
          />
        </div>
      ))}
    </div>
  );
}
