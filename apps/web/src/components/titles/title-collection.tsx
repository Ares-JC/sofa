import { useLingui } from "@lingui/react/macro";
import { IconCheck, IconChecks, IconLoader, IconStack2 } from "@tabler/icons-react";
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
import { orpc } from "@/lib/orpc/client";
import { invalidateTrackingQueries } from "@/lib/orpc/invalidate";

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
  const watchedCount = movies.filter((item) => isWatched(item.id)).length;
  const total = movies.length;

  async function toggle(ids: string[], watched: boolean) {
    setPending((prev) => new Set([...prev, ...ids]));
    setOverrides((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, watched])) }));
    try {
      await (watched ? watch : unwatch)({ scope: "movie", ids });
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
        className="h-9 rounded-lg px-4 text-sm"
      >
        <IconStack2 aria-hidden={true} className="size-3.5" />
        {t`Collection`}
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {watchedCount}/{total}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{collection.name}</DialogTitle>
            <DialogDescription>
              {t`${watchedCount} of ${total} movies watched`}
            </DialogDescription>
          </DialogHeader>

          <ul className="divide-border/50 -mx-1 divide-y">
            {movies.map((item) => {
              const watched = isWatched(item.id);
              const busy = pending.has(item.id);
              const year = item.releaseDate?.slice(0, 4) ?? "";
              const current = item.id === titleId;
              return (
                <li key={item.tmdbId} className="flex items-center gap-3 px-1 py-2">
                  <Link
                    to="/titles/$id"
                    params={{ id: item.id }}
                    onClick={() => setOpen(false)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md hover:opacity-80"
                  >
                    <div className="bg-muted h-16 w-11 shrink-0 overflow-hidden rounded">
                      {item.posterPath && (
                        <img
                          src={item.posterPath}
                          alt=""
                          width={44}
                          height={64}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className={`truncate text-sm ${current ? "text-primary font-medium" : ""}`}>
                        {item.title}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {isReleased(item.releaseDate) ? year : t`Coming soon`}
                        {current ? ` · ${t`This movie`}` : ""}
                      </p>
                    </div>
                  </Link>
                  <Button
                    variant={watched ? "secondary" : "outline"}
                    size="sm"
                    disabled={busy || (!watched && !isReleased(item.releaseDate))}
                    onClick={() => toggle([item.id], !watched)}
                    aria-label={watched ? t`Mark Unwatched` : t`Mark Watched`}
                    className={watched ? "text-primary" : ""}
                  >
                    {busy ? (
                      <IconLoader aria-hidden={true} className="size-3.5 animate-spin" />
                    ) : (
                      <IconCheck aria-hidden={true} className="size-3.5" />
                    )}
                    {watched ? t`Watched` : t`Mark Watched`}
                  </Button>
                </li>
              );
            })}
          </ul>

          {unwatchedIds.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground justify-self-end tracking-wider uppercase"
              onClick={() => toggle(unwatchedIds, true)}
            >
              <IconChecks aria-hidden={true} className="size-3.5" />
              {t`Mark all watched`}
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
