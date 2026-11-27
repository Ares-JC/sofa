import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { IconCheck, IconPlayerPlay } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { thumbHashToUrl } from "@/lib/thumbhash";

import { useQuickWatchEpisode } from "./use-quick-watch";

export interface ContinueWatchingItemProps {
  title: {
    id: string;
    title: string;
    backdropPath: string | null;
    backdropThumbHash?: string | null;
  };
  nextEpisode: {
    id: string;
    seasonNumber: number;
    episodeNumber: number;
    name: string | null;
    stillPath: string | null;
    stillThumbHash?: string | null;
  } | null;
  totalEpisodes: number;
  watchedEpisodes: number;
  titleType?: "movie" | "tv";
  /** Where playback stopped on the media server (half-watched movie or episode). */
  playback?: { positionSeconds: number; durationSeconds: number } | null;
}

function minutesLeft(playback: { positionSeconds: number; durationSeconds: number }) {
  return Math.max(1, Math.round((playback.durationSeconds - playback.positionSeconds) / 60));
}

export function ContinueWatchingCard({ item }: { item: ContinueWatchingItemProps }) {
  const { t } = useLingui();
  const { watchEpisode, pendingId } = useQuickWatchEpisode();
  const stillUrl = item.nextEpisode?.stillPath ?? item.title.backdropPath ?? null;
  const playback = item.playback ?? null;
  const isMovie = item.titleType === "movie";
  const progress = playback
    ? (playback.positionSeconds / playback.durationSeconds) * 100
    : item.totalEpisodes > 0
      ? (item.watchedEpisodes / item.totalEpisodes) * 100
      : 0;
  const remaining = playback ? minutesLeft(playback) : 0;
  const watchedEpisodes = item.watchedEpisodes;
  const totalEpisodes = item.totalEpisodes;

  const nextEpisode = item.nextEpisode;
  const quickWatchSeason = nextEpisode?.seasonNumber;
  const quickWatchEpisode = nextEpisode?.episodeNumber;
  const quickWatchLabel = nextEpisode
    ? t`Mark S${quickWatchSeason} E${quickWatchEpisode} watched`
    : null;

  return (
    <div className="relative w-64 shrink-0 sm:w-72">
      <Link
        to="/titles/$id"
        params={{ id: item.title.id }}
        className="group bg-card/50 relative block w-full overflow-hidden rounded-xl ring-1 ring-white/[0.06] transition-shadow hover:shadow-lg hover:shadow-black/25"
      >
        <div
          className="bg-muted relative aspect-video overflow-hidden rounded-t-xl"
          style={(() => {
            const hash = item.nextEpisode?.stillThumbHash ?? item.title.backdropThumbHash;
            const url = thumbHashToUrl(hash);
            return url ? { backgroundImage: `url(${url})`, backgroundSize: "cover" } : undefined;
          })()}
        >
          {stillUrl ? (
            <img
              src={stillUrl}
              alt={item.nextEpisode?.name ?? item.title.title}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-105"
            />
          ) : (
            <div className="from-card via-secondary to-muted flex h-full items-center justify-center bg-gradient-to-br">
              <IconPlayerPlay aria-hidden={true} className="text-muted-foreground/30 size-8" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          {isMovie && playback && (
            <div className="absolute right-3 bottom-2.5 left-3">
              <p className="text-primary flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase">
                <span className="bg-primary inline-block h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" />
                {t`Resume · ${remaining} min left`}
              </p>
            </div>
          )}
          {item.nextEpisode && (
            <div className="absolute right-3 bottom-2.5 left-3">
              <p className="text-primary flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase">
                <span className="bg-primary inline-block h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" />
                {playback ? t`Resume · ${remaining} min left` : t`Up next`}
              </p>
              <p className="mt-1 truncate text-base font-medium text-white">
                <span className="me-0.5 font-mono text-sm text-white/60 [word-spacing:-0.25em]">
                  S{item.nextEpisode.seasonNumber} E{item.nextEpisode.episodeNumber}
                </span>{" "}
                {item.nextEpisode.name}
              </p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-medium">{item.title.title}</p>
            <p className="text-muted-foreground text-sm">
              {isMovie
                ? t`Movie`
                : t`${watchedEpisodes}/${plural(totalEpisodes, { one: "# episode", other: "# episodes" })}`}
            </p>
          </div>
          <div className="bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full transition-colors">
            <IconPlayerPlay aria-hidden={true} className="size-3.5" />
          </div>
        </div>
        {progress > 0 && (
          <div className="bg-muted absolute right-0 bottom-0 left-0 h-0.5">
            <div
              className="bg-primary h-full transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </Link>
      {nextEpisode && quickWatchLabel && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="secondary"
                size="icon"
                aria-label={quickWatchLabel}
                disabled={pendingId === nextEpisode.id}
                className="absolute end-2 top-2 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70"
                onClick={() =>
                  watchEpisode(
                    nextEpisode.id,
                    `S${nextEpisode.seasonNumber} E${nextEpisode.episodeNumber}`,
                  )
                }
              />
            }
          >
            <IconCheck aria-hidden={true} />
          </TooltipTrigger>
          <TooltipContent side="bottom">{quickWatchLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
