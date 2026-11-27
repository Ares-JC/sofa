import { useLingui } from "@lingui/react/macro";
import {
  IconCheck,
  IconChecks,
  IconLoader,
  IconStack2,
  IconTrophy,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { orpc } from "@/lib/orpc/client";
import { invalidateTrackingQueries, patchExploreStatus } from "@/lib/orpc/invalidate";
import { formatShortDate } from "@sofa/i18n/format";

import { useTitleContext } from "./title-context";

/**
 * "Collection" button for movies that belong to a film series. It opens a small window listing
 * every movie of the series, each with its own watched toggle, so the whole saga can be tracked
 * from one place.
 */
export function CollectionButton() {
  const { t } = useLingui();
  const { titleId, titleType } = useTitleContext();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  /** Optimistic watched state while the server catches up. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const { data } = useQuery({
    ...orpc.titles.collection.queryOptions({ input: { id: titleId } }),
    enabled: titleType === "movie",
    staleTime: 10 * 60_000,
    // The movies' watched marks may have changed elsewhere; re-check them when the page opens
    refetchOnMount: "always",
  });

  const settle = {
    onSettled: async () => {
      await invalidateTrackingQueries(queryClient);
      setOverrides({});
    },
  };
  const { mutateAsync: watch } = useMutation(orpc.tracking.watch.mutationOptions(settle));
  const { mutateAsync: unwatch } = useMutation(orpc.tracking.unwatch.mutationOptions(settle));

  if (titleType !== "movie" || !data?.collection || data.items.length < 2) return null;
  const { collection, items, userStatuses } = data;
  const movies = items.filter((item) => item.id);
  const today = new Date().toISOString().slice(0, 10);
  /** Unreleased movies can't be marked watched yet. */
  const isReleased = (date: string | null) => date != null && date <= today;

  const isWatched = (id: string) => overrides[id] ?? userStatuses[id] === "completed";
  // A sequel with an official release date counts toward the total (2/3), but one with no date
  // yet isn't counted at all (2/2). Either way, unreleased movies can't keep the series from
  // being complete, since they can't be watched yet.
  const released = movies.filter((item) => isReleased(item.releaseDate));
  const scheduled = movies.filter((item) => item.releaseDate && !isReleased(item.releaseDate));
  const watchedCount = released.filter((item) => isWatched(item.id)).length;
  const total = released.length + scheduled.length;
  const upcomingCount = movies.length - released.length;
  /** Every released movie of the series watched: shown as an achievement in gold. */
  const complete = released.length > 0 && watchedCount === released.length;

  async function toggle(ids: string[], watched: boolean) {
    setPending((prev) => new Set([...prev, ...ids]));
    setOverrides((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, watched])) }));
    try {
      await (watched ? watch : unwatch)({ scope: "movie", ids });
      // Explore lists aren't refetched on changes; show (or hide) the watched dot there too
      for (const id of ids) patchExploreStatus(queryClient, id, watched ? "completed" : null);
    } catch {
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      toast.error(watched ? t`Failed to mark as watched` : t`Failed to mark as unwatched`);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }

  const unwatchedIds = movies
    .filter((item) => isReleased(item.releaseDate) && !isWatched(item.id))
    .map((item) => item.id);

  return (
    <>
      <Button
        variant="outline"
        size="lg"
        onClick={() => setOpen(true)}
        title={complete ? t`Collection complete!` : undefined}
        className={`h-9 rounded-lg px-4 text-sm transition-colors ${
          complete
            ? "border-amber-400/50 bg-amber-400/10 text-amber-300 shadow-[0_0_16px_-4px] shadow-amber-400/40 hover:bg-amber-400/20 hover:text-amber-200"
            : ""
        }`}
      >
        {complete ? (
          <IconTrophy aria-hidden={true} className="size-3.5" />
        ) : (
          <IconStack2 aria-hidden={true} className="size-3.5" />
        )}
        {t`Collection`}
        <span
          className={`font-mono text-xs tabular-nums ${complete ? "text-amber-300/80" : "text-muted-foreground"}`}
        >
          {watchedCount}/{total}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="relative gap-1 overflow-hidden px-7 pt-10 pb-6">
            {collection.backdropPath && (
              <img
                src={collection.backdropPath}
                alt=""
                aria-hidden={true}
                className="absolute inset-0 h-full w-full object-cover opacity-35"
              />
            )}
            <div className="from-background via-background/80 to-background/40 absolute inset-0 bg-gradient-to-t" />
            <div className="relative space-y-4 pe-10">
              <div className="space-y-2">
                <DialogTitle className="font-display text-3xl leading-tight tracking-tight text-balance">
                  {collection.name}
                </DialogTitle>
                <DialogDescription className="text-base">
                  {complete ? (
                    <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-sm font-semibold text-amber-300 shadow-[0_0_20px_-6px] shadow-amber-400/50">
                      <IconTrophy aria-hidden={true} className="size-4" />
                      {t`Collection complete!`}
                    </span>
                  ) : (
                    t`${watchedCount} of ${total} movies watched`
                  )}
                  {upcomingCount > 0 && (
                    <span className="text-muted-foreground"> · {t`${upcomingCount} coming soon`}</span>
                  )}
                </DialogDescription>
              </div>
              <Progress
                className={`[&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:rounded-full ${complete ? "[&_[data-slot=progress-indicator]]:bg-amber-400" : ""}`}
                value={released.length > 0 ? (watchedCount / released.length) * 100 : 0}
              />
            </div>
          </DialogHeader>

          <ul className="min-h-0 flex-1 space-y-1.5 overflow-x-hidden overflow-y-auto px-4 py-4">
            {movies.map((item) => {
              const watched = isWatched(item.id);
              const busy = pending.has(item.id);
              const year = item.releaseDate?.slice(0, 4) ?? "";
              const current = item.id === titleId;
              return (
                <li
                  key={item.tmdbId}
                  className={`flex items-center gap-5 rounded-xl p-3 transition-colors ${current ? "bg-primary/10" : "hover:bg-accent/40"}`}
                >
                  <Link
                    to="/titles/$id"
                    params={{ id: item.id }}
                    onClick={() => setOpen(false)}
                    className="flex min-w-0 flex-1 items-center gap-5"
                  >
                    <div className="bg-muted aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg shadow-lg ring-1 ring-white/10">
                      {item.posterPath && (
                        <img
                          src={item.posterPath}
                          alt=""
                          width={64}
                          height={96}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <p
                        className={`line-clamp-2 text-base leading-snug font-medium ${current ? "text-primary" : ""}`}
                      >
                        {item.title}
                      </p>
                      <p className="text-muted-foreground text-sm">
                        {isReleased(item.releaseDate)
                          ? year
                          : item.releaseDate
                            ? t`Release: ${formatShortDate(item.releaseDate)}`
                            : t`Coming soon`}
                        {current ? ` · ${t`This movie`}` : ""}
                      </p>
                    </div>
                  </Link>
                  <Button
                    variant={watched ? "secondary" : "outline"}
                    disabled={busy || (!watched && !isReleased(item.releaseDate))}
                    onClick={() => toggle([item.id], !watched)}
                    aria-label={watched ? t`Mark Unwatched` : t`Mark Watched`}
                    className={`shrink-0 ${watched ? "text-primary" : ""}`}
                  >
                    {busy ? (
                      <IconLoader aria-hidden={true} className="size-4 animate-spin" />
                    ) : (
                      <IconCheck aria-hidden={true} className="size-4" />
                    )}
                    {watched ? t`Watched` : t`Mark Watched`}
                  </Button>
                </li>
              );
            })}
          </ul>

          {unwatchedIds.length > 1 && (
            <div className="border-border/50 flex justify-end border-t px-6 py-4">
              <Button variant="outline" onClick={() => toggle(unwatchedIds, true)}>
                <IconChecks aria-hidden={true} className="size-4" />
                {t`Mark all watched`}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
