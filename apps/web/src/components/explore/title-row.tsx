import { useRef } from "react";

import { TitleCard } from "@/components/title-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { useHideInLibrary, withoutLibraryTitles } from "@/lib/explore-prefs";

const noop = () => {};

interface TitleRowItem {
  id: string;
  type: "movie" | "tv";
  title: string;
  posterPath: string | null;
  posterThumbHash?: string | null;
  releaseDate: string | null;
  firstAirDate: string | null;
  voteAverage: number | null;
  isAnime?: boolean;
}

interface TitleRowProps {
  heading: string;
  icon: React.ReactNode;
  items: TitleRowItem[];
  userStatuses?: Record<string, "in_watchlist" | "watching" | "caught_up" | "completed">;
  episodeProgress?: Record<string, { watched: number; total: number }>;
  onEndReached?: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isFetchNextPageError?: boolean;
}

export function TitleRow({
  heading,
  icon,
  items,
  userStatuses,
  episodeProgress,
  onEndReached,
  hasNextPage = false,
  isFetchingNextPage = false,
  isFetchNextPageError = false,
}: TitleRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useInfiniteScroll({
    fetchNextPage: onEndReached ?? noop,
    hasNextPage: !!onEndReached && hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    rootRef: scrollRef,
    rootMargin: "0px 400px 0px 0px",
  });

  const hideInLibrary = useHideInLibrary();
  const visibleItems = withoutLibraryTitles(
    items,
    hideInLibrary,
    (item) => userStatuses?.[item.id],
  );

  if (visibleItems.length === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="font-display text-xl tracking-tight text-balance">{heading}</h2>
      </div>
      <ScrollArea scrollFade hideScrollbar className="-mx-6 sm:-mx-2" scrollRef={scrollRef}>
        <div className="flex gap-4 px-6 py-2 sm:px-2">
          {visibleItems.map((item, i) => (
            <div key={item.id} className="w-[150px] shrink-0 sm:w-[180px] lg:w-[210px]">
              <div
                className="animate-stagger-item"
                style={{ "--stagger-index": i % 20 } as React.CSSProperties}
              >
                <TitleCard
                  id={item.id}
                  type={item.type}
                  title={item.title}
                  posterPath={item.posterPath}
                  posterThumbHash={item.posterThumbHash}
                  releaseDate={item.releaseDate ?? item.firstAirDate}
                  voteAverage={item.voteAverage}
                  isAnime={item.isAnime}
                  userStatus={userStatuses?.[item.id]}
                  episodeProgress={episodeProgress?.[item.id]}
                />
              </div>
            </div>
          ))}
          {isFetchingNextPage && (
            <div className="flex shrink-0 items-center px-4">
              <div className="border-primary size-5 animate-spin rounded-full border-2 border-t-transparent" />
            </div>
          )}
          <div ref={sentinelRef} className="w-px shrink-0" aria-hidden />
        </div>
      </ScrollArea>
    </section>
  );
}
