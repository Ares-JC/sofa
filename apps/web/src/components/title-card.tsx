import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  IconBookmarkFilled,
  IconCheck,
  IconCircleCheckFilled,
  IconDeviceTv,
  IconLoader,
  IconMovie,
  IconPlayerPlayFilled,
  IconPlus,
  IconStarFilled,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type MotionStyle, type MotionValue, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTiltEffect } from "@/hooks/use-tilt-effect";
import { orpc } from "@/lib/orpc/client";
import { invalidateTrackingQueries, patchExploreStatus } from "@/lib/orpc/invalidate";
import { openTitleSheet } from "@/lib/title-sheet";
import { thumbHashToUrl } from "@/lib/thumbhash";

export function TitleCardSkeleton() {
  return (
    <div className="bg-card overflow-hidden rounded-xl ring-1 ring-white/[0.06]">
      <Skeleton className="aspect-[2/3] w-full rounded-none" />
      <div className="px-3 pt-2.5 pb-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="mt-1.5 h-3 w-1/2" />
      </div>
    </div>
  );
}

type TitleStatus = "in_watchlist" | "watching" | "caught_up" | "completed";

interface TiltStyles {
  imageStyle: MotionStyle;
  glareBackground: MotionValue<string>;
  glareOpacity: MotionValue<number>;
}

interface CardInnerProps {
  title: string;
  type: string;
  posterPath: string | null;
  posterThumbHash?: string | null;
  releaseDate?: string | null;
  voteAverage?: number | null;
  /** Japanese animation: labelled "Anime" instead of "Series"/"Movie". */
  isAnime?: boolean;
  userStatus?: TitleStatus | null;
  episodeProgress?: { watched: number; total: number } | null;
  tiltStyles?: TiltStyles;
}

export interface TitleCardProps extends CardInnerProps {
  id: string;
}

function useStatusConfig() {
  const { t } = useLingui();
  return {
    in_watchlist: {
      icon: IconBookmarkFilled,
      label: t`On Watchlist`,
      badgeClass: "bg-status-watching/90 text-white",
    },
    watching: {
      icon: IconPlayerPlayFilled,
      label: t`Watching`,
      badgeClass: "bg-status-watching/90 text-white",
    },
    caught_up: {
      icon: IconCircleCheckFilled,
      label: t`Caught Up`,
      badgeClass: "bg-status-watching/90 text-white",
    },
    completed: {
      icon: IconCircleCheckFilled,
      label: t`Completed`,
      badgeClass: "bg-status-completed/90 text-white",
    },
  } as const;
}

function QuickAddButton({ id, userStatus }: { id: string; userStatus?: TitleStatus | null }) {
  const { t } = useLingui();
  const statusConfig = useStatusConfig();
  const queryClient = useQueryClient();
  const [optimisticStatus, setOptimisticStatus] = useState<TitleStatus | null>(null);

  const addToWatchlistMutation = useMutation(
    orpc.tracking.updateStatus.mutationOptions({
      onSuccess: () => {
        setOptimisticStatus("in_watchlist");
        patchExploreStatus(queryClient, id, "in_watchlist");
      },
      onError: () => toast.error(t`Failed to update status`),
      onSettled: () => void invalidateTrackingQueries(queryClient),
    }),
  );

  const addedStatus = optimisticStatus ?? userStatus ?? null;
  const isAdded = addedStatus != null;
  const config = addedStatus ? statusConfig[addedStatus] : null;

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (addToWatchlistMutation.isPending || isAdded) return;
    addToWatchlistMutation.mutate({ id, status: "watchlist" });
  }

  if (isAdded && config) {
    const StatusIcon = config.icon;
    return (
      <Tooltip>
        <TooltipTrigger
          className="absolute end-2 top-2 z-10 flex size-8 cursor-default items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm"
          render={<div />}
        >
          <StatusIcon className="size-4" />
        </TooltipTrigger>
        <TooltipContent side="bottom">{config.label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={handleClick}
        className="absolute end-2 top-2 z-10 flex size-8 items-center justify-center rounded-full bg-black/50 text-white opacity-60 backdrop-blur-sm transition-opacity hover:bg-black/70 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        render={<button type="button" aria-label={t`Add to Watchlist`} />}
      >
        {!addToWatchlistMutation.isPending && <IconPlus className="size-4" />}
        {addToWatchlistMutation.isPending && <IconLoader className="size-4 animate-spin" />}
      </TooltipTrigger>
      <TooltipContent side="bottom">{t`Add to Watchlist`}</TooltipContent>
    </Tooltip>
  );
}

/** How long the "mark as watched" button must be held, so it can't be triggered by accident. */
const HOLD_TO_WATCH_MS = 900;

/**
 * Mark a movie as watched straight from its card. It has to be held down while a ring fills up
 * (like a loading circle) so a stray click never logs a watch by mistake.
 */
function HoldToWatchButton({ id, onWatched }: { id: string; onWatched: () => void }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const watchMutation = useMutation(
    orpc.tracking.watch.mutationOptions({
      onSuccess: () => {
        onWatched();
        patchExploreStatus(queryClient, id, "completed");
        toast.success(t`Marked as watched`);
      },
      onError: () => toast.error(t`Failed to mark as watched`),
      onSettled: () => void invalidateTrackingQueries(queryClient),
    }),
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function start() {
    if (watchMutation.isPending || timer.current) return;
    setHint(false);
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      watchMutation.mutate({ scope: "movie", ids: [id] });
    }, HOLD_TO_WATCH_MS);
  }

  function cancel(showHint: boolean) {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    if (showHint) setHint(true);
  }

  // Ring geometry: a circle drawn just inside the 32px button.
  const radius = 14;
  const circumference = 2 * Math.PI * radius;

  return (
    <Tooltip
      open={tooltipOpen || hint}
      onOpenChange={(open) => {
        setTooltipOpen(open);
        if (!open) setHint(false);
      }}
    >
      <TooltipTrigger
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          start();
        }}
        onPointerUp={() => cancel(true)}
        onPointerLeave={() => cancel(false)}
        onPointerCancel={() => cancel(false)}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") cancel(true);
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={`absolute start-2 top-2 z-10 flex size-8 touch-none items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-[opacity,background-color,transform] select-none hover:bg-black/70 focus-visible:opacity-100 sm:group-hover:opacity-100 ${
          holding ? "scale-110 opacity-100" : "opacity-60 sm:opacity-0"
        }`}
        render={<button type="button" aria-label={t`Hold to mark as watched`} />}
      >
        <svg
          aria-hidden={true}
          viewBox="0 0 32 32"
          className="pointer-events-none absolute inset-0 size-8 -rotate-90"
        >
          <circle
            cx="16"
            cy="16"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="text-status-completed"
            strokeDasharray={circumference}
            strokeDashoffset={holding ? 0 : circumference}
            style={{
              transition: holding
                ? `stroke-dashoffset ${HOLD_TO_WATCH_MS}ms linear`
                : "stroke-dashoffset 150ms ease-out",
            }}
          />
        </svg>
        {watchMutation.isPending ? (
          <IconLoader className="size-4 animate-spin" />
        ) : (
          <IconCheck className={`size-4 transition-colors ${holding ? "text-status-completed" : ""}`} />
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {hint ? t`Keep holding to mark as watched` : t`Hold to mark as watched`}
      </TooltipContent>
    </Tooltip>
  );
}

function ProgressBar({ watched, total }: { watched: number; total: number }) {
  const { t } = useLingui();
  const pct = total > 0 ? (watched / total) * 100 : 0;
  return (
    <Tooltip>
      <TooltipTrigger
        className="absolute right-0 bottom-0 left-0 z-10 h-1 cursor-default bg-white/10"
        render={<div />}
      >
        <div
          className="bg-status-watching h-full transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        {t`${watched}/${plural(total, { one: "# episode", other: "# episodes" })}`}
      </TooltipContent>
    </Tooltip>
  );
}

function CardInner({
  title,
  type,
  posterPath,
  posterThumbHash,
  releaseDate,
  voteAverage,
  isAnime,
  userStatus,
  episodeProgress,
  tiltStyles,
}: CardInnerProps) {
  const { t } = useLingui();
  const statusConfig = useStatusConfig();
  const typeLabel = isAnime ? t`Anime` : type === "movie" ? t`Movie` : t`Series`;
  const year = releaseDate?.slice(0, 4);
  const TypeIcon = type === "movie" ? IconMovie : IconDeviceTv;
  const placeholderUrl = thumbHashToUrl(posterThumbHash);

  const ringClass = userStatus ? "ring-primary/25 shadow-sm shadow-primary/5" : "ring-white/[0.06]";

  return (
    <div
      className={`bg-card hover:shadow-primary/5 hover:ring-primary/25 relative overflow-hidden rounded-xl ring-1 transition-[box-shadow,ring-color] duration-200 ease-out hover:shadow-lg ${ringClass}`}
    >
      <div
        className="bg-card aspect-[2/3] overflow-hidden"
        style={
          placeholderUrl
            ? {
                backgroundImage: `url(${placeholderUrl})`,
                backgroundSize: "cover",
              }
            : undefined
        }
      >
        {posterPath ? (
          <motion.div style={tiltStyles?.imageStyle}>
            <img
              src={posterPath}
              alt={title}
              width={300}
              height={450}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          </motion.div>
        ) : (
          <div className="from-card via-secondary to-muted relative flex h-full items-center justify-center overflow-hidden bg-gradient-to-br">
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.06]"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
              }}
            />
            <div className="from-primary/10 absolute inset-0 bg-gradient-to-t via-transparent to-transparent" />
            <div className="relative px-3 text-center">
              <p className="font-display text-foreground/70 text-sm leading-snug tracking-tight">
                {title}
              </p>
            </div>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
        {tiltStyles && (
          <motion.div
            className="pointer-events-none absolute inset-0 z-[5] rounded-xl"
            style={{
              background: tiltStyles.glareBackground,
              opacity: tiltStyles.glareOpacity,
            }}
          />
        )}
      </div>

      <div className="px-3 pt-2.5 pb-3">
        <div className="flex items-center gap-1.5">
          {userStatus && (
            <Tooltip>
              <TooltipTrigger
                className="shrink-0 cursor-default"
                render={<div className="flex items-center" />}
              >
                <span className="relative flex size-2">
                  <span
                    className={`absolute inline-flex h-full w-full rounded-full opacity-40 ${userStatus === "completed" ? "bg-status-completed" : "bg-status-watching"}`}
                  />
                  <span
                    className={`relative inline-flex size-2 rounded-full ${userStatus === "completed" ? "bg-status-completed" : "bg-status-watching"}`}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>{statusConfig[userStatus].label}</TooltipContent>
            </Tooltip>
          )}
          <p className="line-clamp-1 text-sm leading-snug font-medium">{title}</p>
        </div>
        <div className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs">
          <span className="border-primary/25 bg-primary/10 text-primary inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[10px] font-medium tracking-wide uppercase">
            <TypeIcon aria-hidden={true} className="size-3" />
            {typeLabel}
          </span>
          {year && <span>{year}</span>}
          {voteAverage != null && voteAverage > 0 && (
            <span className="text-primary/80 ml-auto flex items-center gap-0.5">
              <IconStarFilled aria-hidden={true} className="size-[11px]" />
              {voteAverage.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      {episodeProgress && episodeProgress.watched > 0 && (
        <ProgressBar watched={episodeProgress.watched} total={episodeProgress.total} />
      )}
    </div>
  );
}

export function TitleCard({
  id,
  type,
  title,
  posterPath,
  posterThumbHash,
  releaseDate,
  voteAverage,
  isAnime,
  userStatus,
  episodeProgress,
}: TitleCardProps) {
  const [watchedNow, setWatchedNow] = useState(false);
  const {
    ref: tiltRef,
    containerStyle,
    imageStyle,
    glareBackground,
    glareOpacity,
    handlers,
  } = useTiltEffect();

  const navigate = useNavigate();
  const cardContent = (
    <motion.div ref={tiltRef} style={containerStyle} {...handlers}>
      <CardInner
        title={title}
        type={type}
        posterPath={posterPath}
        posterThumbHash={posterThumbHash}
        releaseDate={releaseDate}
        voteAverage={voteAverage}
        isAnime={isAnime}
        userStatus={userStatus}
        episodeProgress={episodeProgress}
        tiltStyles={{
          imageStyle,
          glareBackground,
          glareOpacity,
        }}
      />
    </motion.div>
  );

  const isWatched = watchedNow || userStatus === "completed";

  return (
    <div className="group relative">
      {type === "movie" && !isWatched && (
        <HoldToWatchButton id={id} onWatched={() => setWatchedNow(true)} />
      )}
      <QuickAddButton id={id} userStatus={watchedNow ? "completed" : userStatus} />
      <Link
        to="/titles/$id"
        params={{ id }}
        onClick={(e) => {
          // Phones: open over the current page as a sheet, like the mobile app
          if (
            openTitleSheet(id, e, () => void navigate({ to: "/titles/$id", params: { id } }))
          ) {
            e.preventDefault();
          }
        }}
      >
        {cardContent}
      </Link>
    </div>
  );
}
