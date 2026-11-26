import { and, desc, eq, gte, inArray, max } from "drizzle-orm";

import { db } from "../client";
import { playbackProgress, titles, userMovieWatches } from "../schema";

export function upsertPlaybackProgress(values: {
  userId: string;
  titleId: string;
  episodeId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  source: "plex" | "jellyfin" | "emby";
}) {
  const mediaKey = values.episodeId ?? values.titleId;
  const updatedAt = new Date();
  db.insert(playbackProgress)
    .values({ ...values, mediaKey, updatedAt })
    .onConflictDoUpdate({
      target: [playbackProgress.userId, playbackProgress.mediaKey],
      set: {
        positionSeconds: values.positionSeconds,
        durationSeconds: values.durationSeconds,
        source: values.source,
        updatedAt,
      },
    })
    .run();
}

/** Forget progress once an item is watched (mediaKey: episode ID, or title ID for movies). */
export function deletePlaybackProgress(userId: string, mediaKey: string) {
  db.delete(playbackProgress)
    .where(and(eq(playbackProgress.userId, userId), eq(playbackProgress.mediaKey, mediaKey)))
    .run();
}

/** A user's recent progress rows, newest first, with each row's title for display. */
export function getRecentPlaybackProgress(userId: string, since: Date) {
  return db
    .select({
      titleId: playbackProgress.titleId,
      episodeId: playbackProgress.episodeId,
      positionSeconds: playbackProgress.positionSeconds,
      durationSeconds: playbackProgress.durationSeconds,
      updatedAt: playbackProgress.updatedAt,
      titleType: titles.type,
      title: titles.title,
      posterPath: titles.posterPath,
      backdropPath: titles.backdropPath,
      backdropThumbHash: titles.backdropThumbHash,
    })
    .from(playbackProgress)
    .innerJoin(titles, eq(titles.id, playbackProgress.titleId))
    .where(and(eq(playbackProgress.userId, userId), gte(playbackProgress.updatedAt, since)))
    .orderBy(desc(playbackProgress.updatedAt))
    .all();
}

/** Latest watch date per movie, for the given titles. */
export function getLatestMovieWatchDates(userId: string, titleIds: string[]) {
  if (titleIds.length === 0) return new Map<string, Date>();
  const rows = db
    .select({ titleId: userMovieWatches.titleId, watchedAt: max(userMovieWatches.watchedAt) })
    .from(userMovieWatches)
    .where(and(eq(userMovieWatches.userId, userId), inArray(userMovieWatches.titleId, titleIds)))
    .groupBy(userMovieWatches.titleId)
    .all();
  const result = new Map<string, Date>();
  for (const row of rows) if (row.watchedAt) result.set(row.titleId, row.watchedAt);
  return result;
}
