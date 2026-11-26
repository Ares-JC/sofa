import { updateIntegrationSettings } from "@sofa/db/queries/integrations";
import { deletePlaybackProgress, upsertPlaybackProgress } from "@sofa/db/queries/playback";
import { findEpisodeBySeasonAndNumber, findSeasonByTitleAndNumber } from "@sofa/db/queries/title";
import {
  getLibraryShows,
  getRecentEpisodeWatch,
  getRecentMovieWatch,
  insertIntegrationEventTransaction,
} from "@sofa/db/queries/webhooks";
import { createLogger } from "@sofa/logger";
import { getTvDetails } from "@sofa/tmdb/client";

import {
  resolveEpisodeByExternalIds,
  resolveMovieTmdbId,
  resolveShowTmdbId,
} from "./imports/resolve";
import { getOrFetchTitleByTmdbId, refreshTvChildren } from "./metadata";
import { logEpisodeWatch, logMovieWatch } from "./tracking";

const log = createLogger("webhooks");

const IMDB_GUID_PREFIX = "imdb://";
const TMDB_GUID_PREFIX = "tmdb://";
const TVDB_GUID_PREFIX = "tvdb://";

// ─── Types ──────────────────────────────────────────────────────────

export interface WebhookEvent {
  provider: "plex" | "jellyfin" | "emby";
  mediaType: "movie" | "episode";
  title: string;
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  showTitle?: string;
  /** Display name of the media server account that played the item, when the payload has one. */
  username?: string;
  /** Stable media server account ID (Plex `Account.id`, Jellyfin `UserId`, Emby `User.Id`). */
  accountId?: string;
}

export interface AllowedAccount {
  id: string;
  name: string;
}

/** @internal */
export function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether an event passes an integration's username filter. No filter accepts everyone; with a
 * filter, the event must name the same user (compared case-insensitively).
 */
export function matchesServerUsername(
  expected: string | null | undefined,
  actual: string | undefined,
): boolean {
  const wanted = toOptionalString(expected);
  if (!wanted) return true;
  if (!actual) return false;
  return wanted.localeCompare(actual, undefined, { sensitivity: "accent" }) === 0;
}

/** Account IDs arrive as numbers (Plex) or strings (Jellyfin, Emby). */
function toOptionalId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return toOptionalString(value);
}

/**
 * Whether an event passes an integration's account filter.
 *
 * - `allowedAccounts` (non-empty): the event's account ID must be in the list. Payloads without an
 *   ID fall back to comparing the display name.
 * - Otherwise the legacy `serverUsername` name filter applies (none = accept everyone).
 */
export function isAccountAllowed(
  event: Pick<WebhookEvent, "accountId" | "username">,
  allowedAccounts: AllowedAccount[] | null | undefined,
  serverUsername?: string | null,
): boolean {
  if (allowedAccounts && allowedAccounts.length > 0) {
    if (event.accountId) return allowedAccounts.some((a) => a.id === event.accountId);
    return allowedAccounts.some((a) => matchesServerUsername(a.name, event.username));
  }
  return matchesServerUsername(serverUsername, event.username);
}

/** @internal */
export function toOptionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

// ─── Payload Parsers ────────────────────────────────────────────────

export function parsePlexPayload(formData: FormData): WebhookEvent | null {
  const payload = parsePlexJson(formData);
  if (!payload || payload.event !== "media.scrobble") return null;
  return plexEvent(payload);
}

function parsePlexJson(formData: FormData): Record<string, unknown> | null {
  const raw = formData.get("payload");
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function plexEvent(payload: Record<string, unknown>): WebhookEvent | null {
  const metadata = payload.Metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;

  const metaType = metadata.type as string;
  const isMovie = metaType === "movie";
  const isEpisode = metaType === "episode";
  if (!isMovie && !isEpisode) return null;

  // Extract external IDs from Guid array
  const guids = (metadata.Guid ?? metadata.guid) as { id: string }[] | undefined;
  let tmdbId: number | undefined;
  let imdbId: string | undefined;
  let tvdbId: string | undefined;

  if (Array.isArray(guids)) {
    for (const g of guids) {
      const id = g.id ?? "";
      if (id.startsWith(TMDB_GUID_PREFIX)) {
        // Plex episode TMDB GUIDs identify episodes, not series.
        if (isMovie) tmdbId = toOptionalInt(id.slice(TMDB_GUID_PREFIX.length));
      } else if (id.startsWith(IMDB_GUID_PREFIX)) {
        imdbId = id.slice(IMDB_GUID_PREFIX.length);
      } else if (id.startsWith(TVDB_GUID_PREFIX)) {
        tvdbId = id.slice(TVDB_GUID_PREFIX.length);
      }
    }
  }

  return {
    provider: "plex",
    mediaType: isMovie ? "movie" : "episode",
    title: (metadata.title ?? metadata.Title ?? "") as string,
    tmdbId,
    imdbId,
    tvdbId,
    seasonNumber: toOptionalInt(metadata.parentIndex),
    episodeNumber: toOptionalInt(metadata.index),
    showTitle: (metadata.grandparentTitle ?? metadata.parentTitle) as string | undefined,
    // Plex sends one webhook per account for every user on the server; `Account` says who played it.
    username: toOptionalString((payload.Account as Record<string, unknown> | undefined)?.title),
    accountId: toOptionalId((payload.Account as Record<string, unknown> | undefined)?.id),
  };
}

export function parseJellyfinPayload(body: Record<string, unknown>): WebhookEvent | null {
  const notifType = body.NotificationType as string | undefined;
  if (notifType !== "PlaybackStop") return null;
  if (body.PlayedToCompletion !== true) return null;
  return jellyfinEvent(body);
}

function jellyfinEvent(body: Record<string, unknown>): WebhookEvent | null {
  const itemType = body.ItemType as string | undefined;
  const isMovie = itemType === "Movie";
  const isEpisode = itemType === "Episode";
  if (!isMovie && !isEpisode) return null;

  // Item-level TMDB ids on episode events identify the episode, not the series
  // (same as Plex, see #53) — rely on IMDb/TVDB/title to resolve the show.
  const tmdbId = isMovie ? toOptionalInt(body.Provider_tmdb) : undefined;

  return {
    provider: "jellyfin",
    mediaType: isMovie ? "movie" : "episode",
    title: (body.Name ?? "") as string,
    tmdbId,
    imdbId: (body.Provider_imdb as string) || undefined,
    tvdbId: (body.Provider_tvdb as string) || undefined,
    seasonNumber: toOptionalInt(body.SeasonNumber),
    episodeNumber: toOptionalInt(body.EpisodeNumber),
    showTitle: (body.SeriesName ?? body.ShowName) as string | undefined,
    username: toOptionalString(body.NotificationUsername) ?? toOptionalString(body.Username),
    accountId: toOptionalId(body.UserId),
  };
}

export function parseEmbyPayload(body: Record<string, unknown>): WebhookEvent | null {
  // Emby sends "playback.stop" or "PlaybackStop" depending on webhook plugin version
  const event = body.Event as string | undefined;
  if (event !== "playback.stop" && event !== "PlaybackStop") return null;

  // Native Emby webhooks (4.7.9+) nest the flag under PlaybackInfo; older plugin
  // payloads put it at the top level. Accept either.
  const playbackInfo = body.PlaybackInfo as Record<string, unknown> | undefined;
  const playedToCompletion =
    body.PlayedToCompletion === true || playbackInfo?.PlayedToCompletion === true;
  if (!playedToCompletion) return null;
  return embyEvent(body);
}

function embyEvent(body: Record<string, unknown>): WebhookEvent | null {
  const item = body.Item as Record<string, unknown> | undefined;
  if (!item) return null;

  const itemType = item.Type as string | undefined;
  const isMovie = itemType === "Movie";
  const isEpisode = itemType === "Episode";
  if (!isMovie && !isEpisode) return null;

  const providerIds = (item.ProviderIds ?? {}) as Record<string, string>;
  // Item-level TMDB ids on episode events identify the episode, not the series
  // (same as Plex, see #53) — rely on IMDb/TVDB/title to resolve the show.
  const tmdbId = isMovie ? toOptionalInt(providerIds.Tmdb) : undefined;

  return {
    provider: "emby",
    mediaType: isMovie ? "movie" : "episode",
    title: (item.Name ?? "") as string,
    tmdbId,
    imdbId: providerIds.Imdb || undefined,
    tvdbId: providerIds.Tvdb || undefined,
    seasonNumber: toOptionalInt(item.ParentIndexNumber),
    episodeNumber: toOptionalInt(item.IndexNumber),
    showTitle: (item.SeriesName ?? item.ShowName) as string | undefined,
    username: toOptionalString((body.User as Record<string, unknown> | undefined)?.Name),
    accountId:
      toOptionalId((body.User as Record<string, unknown> | undefined)?.Id) ??
      toOptionalId(body.UserId),
  };
}

// ─── Playback Progress Parsers ──────────────────────────────────────

export interface PlaybackProgressEvent extends WebhookEvent {
  positionSeconds: number;
  durationSeconds: number;
}

/** .NET ticks (Jellyfin/Emby) are 100 ns. */
const TICKS_PER_SECOND = 10_000_000;

function withProgress(
  event: WebhookEvent | null,
  position: number | undefined,
  duration: number | undefined,
): PlaybackProgressEvent | null {
  if (!event || position == null || duration == null) return null;
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  return {
    ...event,
    positionSeconds: Math.max(0, Math.round(position)),
    durationSeconds: Math.round(duration),
  };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Plex pause/stop: where playback stopped (`viewOffset`, ms) out of `duration` (ms). */
export function parsePlexProgress(formData: FormData): PlaybackProgressEvent | null {
  const payload = parsePlexJson(formData);
  if (!payload || (payload.event !== "media.pause" && payload.event !== "media.stop")) return null;
  const metadata = payload.Metadata as Record<string, unknown> | undefined;
  const offset = toNumber(metadata?.viewOffset);
  const duration = toNumber(metadata?.duration);
  return withProgress(
    plexEvent(payload),
    offset == null ? undefined : offset / 1000,
    duration == null ? undefined : duration / 1000,
  );
}

/** Jellyfin: stopped before the end, or paused (PlaybackProgress with IsPaused). */
export function parseJellyfinProgress(body: Record<string, unknown>): PlaybackProgressEvent | null {
  const notifType = body.NotificationType as string | undefined;
  const stoppedEarly = notifType === "PlaybackStop" && body.PlayedToCompletion !== true;
  const paused = notifType === "PlaybackProgress" && body.IsPaused === true;
  if (!stoppedEarly && !paused) return null;
  const position = toNumber(body.PlaybackPositionTicks);
  const duration = toNumber(body.RunTimeTicks);
  return withProgress(
    jellyfinEvent(body),
    position == null ? undefined : position / TICKS_PER_SECOND,
    duration == null ? undefined : duration / TICKS_PER_SECOND,
  );
}

/** Emby: paused, or stopped before the end. */
export function parseEmbyProgress(body: Record<string, unknown>): PlaybackProgressEvent | null {
  const event = body.Event as string | undefined;
  const isPause = event === "playback.pause";
  const isStop = event === "playback.stop" || event === "PlaybackStop";
  if (!isPause && !isStop) return null;
  const playbackInfo = body.PlaybackInfo as Record<string, unknown> | undefined;
  if (isStop && (body.PlayedToCompletion === true || playbackInfo?.PlayedToCompletion === true)) {
    return null;
  }
  const item = body.Item as Record<string, unknown> | undefined;
  const position = toNumber(playbackInfo?.PositionTicks ?? body.PlaybackPositionTicks);
  const duration = toNumber(item?.RunTimeTicks);
  return withProgress(
    embyEvent(body),
    position == null ? undefined : position / TICKS_PER_SECOND,
    duration == null ? undefined : duration / TICKS_PER_SECOND,
  );
}

// ─── Title Resolution ───────────────────────────────────────────────

/** @internal Loose title key: "Ranma ½" and "Ranma1/2" both become "ranma12". */
export function normalizeShowTitle(title: string): string {
  return title
    .replaceAll("½", "1/2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The show in the user's library whose title matches, preferring ones they're watching. */
function findLibraryShowByTitle(userId: string, showTitle: string): number | null {
  const wanted = normalizeShowTitle(showTitle);
  if (!wanted) return null;
  const matches = getLibraryShows(userId).filter(
    (show) =>
      normalizeShowTitle(show.title) === wanted ||
      (show.originalTitle != null && normalizeShowTitle(show.originalTitle) === wanted),
  );
  const best = matches.find((show) => show.status === "in_progress") ?? matches[0];
  return best?.tmdbId ?? null;
}

async function resolveEpisode(
  event: WebhookEvent,
  userId: string,
): Promise<{
  showTmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  via: string;
} | null> {
  const { seasonNumber, episodeNumber } = event;
  if (seasonNumber == null || episodeNumber == null) return null;

  // 1. The episode's own IDs give TMDB's show and numbering, so a media server that numbers
  //    seasons differently (TVDB ordering, common for anime) still lands on the right episode.
  const exact = await resolveEpisodeByExternalIds({ imdbId: event.imdbId, tvdbId: event.tvdbId });
  if (exact) return { ...exact, via: "episode ID" };

  // 2. A show the user already tracks beats an arbitrary search hit with the same name.
  if (event.showTitle) {
    const libraryShow = findLibraryShowByTitle(userId, event.showTitle);
    if (libraryShow) {
      return { showTmdbId: libraryShow, seasonNumber, episodeNumber, via: "library title" };
    }
  }

  // 3. Last resort: resolve the show itself (its IDs may still point at a show), then by title.
  const showTmdbId = await resolveShowTmdbId({
    imdbId: event.imdbId,
    tvdbId: event.tvdbId,
    title: event.showTitle,
  });
  if (!showTmdbId) return null;
  return { showTmdbId, seasonNumber, episodeNumber, via: "title search" };
}

// ─── Deduplication ──────────────────────────────────────────────────

function isDuplicateMovieWatch(userId: string, titleId: string): boolean {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recent = getRecentMovieWatch(userId, titleId, fiveMinutesAgo);
  return !!recent;
}

function isDuplicateEpisodeWatch(userId: string, episodeId: string): boolean {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recent = getRecentEpisodeWatch(userId, episodeId, fiveMinutesAgo);
  return !!recent;
}

// ─── Event Logging ──────────────────────────────────────────────────

function logEvent(
  connectionId: string,
  event: WebhookEvent | null,
  status: "success" | "ignored" | "error",
  errorMessage?: string,
) {
  insertIntegrationEventTransaction(
    {
      integrationId: connectionId,
      eventType:
        event?.provider === "plex"
          ? "media.scrobble"
          : event?.provider === "emby"
            ? "playback.stop"
            : "PlaybackStop",
      mediaType: event?.mediaType ?? null,
      mediaTitle: event?.title || null,
      status,
      errorMessage: errorMessage ?? null,
      accountId: event?.accountId ?? null,
      accountName: event?.username ?? null,
      receivedAt: new Date(),
    },
    connectionId,
  );
}

// ─── Main Processing ────────────────────────────────────────────────

export async function processWebhook(
  connectionId: string,
  userId: string,
  provider: "plex" | "jellyfin" | "emby",
  event: WebhookEvent,
  options: {
    allowedAccounts?: AllowedAccount[] | null;
    serverUsername?: string | null;
  } = {},
): Promise<{ status: "success" | "ignored" | "error"; message: string }> {
  if (!isAccountAllowed(event, options.allowedAccounts, options.serverUsername)) {
    const message =
      event.username || event.accountId
        ? `Played by another ${provider} user`
        : `No ${provider} user in the event to match`;
    // Don't record what someone else watched, in the server log or this user's event log. The
    // account is kept so it can be picked in Settings.
    log.info(`Ignored ${provider} webhook: ${message}`);
    logEvent(connectionId, { ...event, title: "" }, "ignored", message);
    return { status: "ignored", message };
  }

  // A legacy name filter that just matched an account with a stable ID becomes an ID filter, so
  // renaming the account later doesn't silently stop it.
  if (
    !options.allowedAccounts?.length &&
    options.serverUsername &&
    event.accountId &&
    event.username
  ) {
    try {
      updateIntegrationSettings(connectionId, {
        allowedAccounts: [{ id: event.accountId, name: event.username }],
        serverUsername: null,
      });
      log.info(`Converted ${provider} user filter "${event.username}" to its account ID`);
    } catch (err) {
      log.warn(`Couldn't convert ${provider} user filter: ${String(err)}`);
    }
  }

  log.info(`Received ${provider} webhook: ${event.mediaType} "${event.title}"`);

  try {
    const resolved = await resolveTarget(event, userId, provider);
    if (!resolved.ok) {
      logEvent(connectionId, event, resolved.status, resolved.logMessage);
      return { status: resolved.status, message: resolved.message };
    }
    const target = resolved.target;

    if (target.kind === "movie") {
      if (isDuplicateMovieWatch(userId, target.titleId)) {
        log.debug(`Duplicate movie watch ignored: "${event.title}"`);
        logEvent(connectionId, event, "ignored", "Duplicate watch within 5 minutes");
        return { status: "ignored", message: "Duplicate watch" };
      }

      logMovieWatch(userId, target.titleId, provider);
      deletePlaybackProgress(userId, target.titleId);
      log.info(`Logged movie watch: "${event.title}" (TMDB ${target.tmdbId})`);
      logEvent(connectionId, event, "success");
      return { status: "success", message: `Logged watch for ${event.title}` };
    }

    if (isDuplicateEpisodeWatch(userId, target.episodeId)) {
      log.debug(`Duplicate episode watch ignored: "${event.title}"`);
      logEvent(connectionId, event, "ignored", "Duplicate watch within 5 minutes");
      return { status: "ignored", message: "Duplicate watch" };
    }

    logEpisodeWatch(userId, target.episodeId, provider);
    deletePlaybackProgress(userId, target.episodeId);
    log.info(
      `Logged episode watch: "${event.title}" S${target.seasonNumber}E${target.episodeNumber}`,
    );
    logEvent(connectionId, event, "success");
    return { status: "success", message: `Logged watch for ${event.title}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    try {
      logEvent(connectionId, event, "error", message);
    } catch {
      // best-effort
    }
    return { status: "error", message };
  }
}

// ─── Target Resolution ──────────────────────────────────────────────

type WatchTarget =
  | { kind: "movie"; titleId: string; tmdbId: number }
  | {
      kind: "episode";
      titleId: string;
      episodeId: string;
      seasonNumber: number;
      episodeNumber: number;
    };

type TargetResult =
  | { ok: true; target: WatchTarget }
  | { ok: false; status: "ignored" | "error"; message: string; logMessage: string };

function targetFailure(
  status: "ignored" | "error",
  message: string,
  logMessage = message,
): TargetResult {
  return { ok: false, status, message, logMessage };
}

/** Find (importing if needed) the movie or episode a webhook event refers to. */
async function resolveTarget(
  event: WebhookEvent,
  userId: string,
  provider: "plex" | "jellyfin" | "emby",
): Promise<TargetResult> {
  if (event.mediaType === "movie") {
    const hasExternalId = event.tmdbId || event.imdbId || event.tvdbId;
    const tmdbId = await resolveMovieTmdbId({
      tmdbId: event.tmdbId,
      imdbId: event.imdbId,
      tvdbId: event.tvdbId,
      // Only use title fallback when at least one external ID is present;
      // title-only resolution without year is too unreliable for webhooks
      title: hasExternalId ? event.title : undefined,
    });
    if (!tmdbId) {
      log.warn(`Could not resolve TMDB ID for movie "${event.title}" from ${provider}`);
      return targetFailure(
        "error",
        "Could not resolve TMDB ID",
        "Could not resolve TMDB ID for movie",
      );
    }

    const title = await getOrFetchTitleByTmdbId(tmdbId, "movie");
    if (!title) return targetFailure("error", "Failed to import movie");
    return { ok: true, target: { kind: "movie", titleId: title.id, tmdbId } };
  }

  if (event.mediaType !== "episode") {
    return targetFailure(
      "ignored",
      "Unsupported media type",
      `Unsupported media type: ${event.mediaType}`,
    );
  }

  const resolved = await resolveEpisode(event, userId);
  if (!resolved) {
    log.warn(`Could not resolve episode "${event.title}" from ${provider}`);
    return targetFailure("error", "Could not resolve episode");
  }

  const title = await getOrFetchTitleByTmdbId(resolved.showTmdbId, "tv");
  if (!title) return targetFailure("error", "Failed to import TV show");

  log.info(
    `Matched ${provider} "${event.showTitle ?? event.title}" S${event.seasonNumber}E${event.episodeNumber} ` +
      `to "${title.title}" (TMDB ${resolved.showTmdbId}) S${resolved.seasonNumber}E${resolved.episodeNumber} via ${resolved.via}`,
  );

  // Find the episode in our DB
  let season = findSeasonByTitleAndNumber(title.id, resolved.seasonNumber);

  // Sofa doesn't store specials (season 0). Don't refetch the whole show for them.
  if (!season && resolved.seasonNumber === 0) {
    return targetFailure(
      "ignored",
      "Specials are not tracked",
      "Specials (season 0) are not tracked",
    );
  }

  let episode = season
    ? findEpisodeBySeasonAndNumber(season.id, resolved.episodeNumber)
    : undefined;

  if (!episode) {
    // Season or episode may be newer than our last TMDB fetch — refresh once.
    try {
      const show = await getTvDetails(resolved.showTmdbId);
      await refreshTvChildren(title.id, resolved.showTmdbId, show.number_of_seasons);
      season = findSeasonByTitleAndNumber(title.id, resolved.seasonNumber);
      episode = season
        ? findEpisodeBySeasonAndNumber(season.id, resolved.episodeNumber)
        : undefined;
    } catch (err) {
      log.warn(`Failed to refresh seasons for TMDB ${resolved.showTmdbId}:`, err);
    }
  }

  if (!season) return targetFailure("error", `Season ${resolved.seasonNumber} not found`);
  if (!episode) {
    return targetFailure("error", `S${resolved.seasonNumber}E${resolved.episodeNumber} not found`);
  }

  return {
    ok: true,
    target: {
      kind: "episode",
      titleId: title.id,
      episodeId: episode.id,
      seasonNumber: resolved.seasonNumber,
      episodeNumber: resolved.episodeNumber,
    },
  };
}

// ─── Playback Progress ──────────────────────────────────────────────

/** Ignore blips at the very start and the end (the scrobble covers finished items). */
const MIN_PROGRESS_SECONDS = 60;
const MAX_PROGRESS_FRACTION = 0.95;

/**
 * Remember where the user stopped a movie or episode, for Continue Watching. Progress events are
 * frequent, so they're not written to the integration's event log, and failures are only logged.
 */
export async function processPlaybackProgress(
  userId: string,
  provider: "plex" | "jellyfin" | "emby",
  event: PlaybackProgressEvent,
  options: { allowedAccounts?: AllowedAccount[] | null; serverUsername?: string | null } = {},
): Promise<{ status: "success" | "ignored" | "error"; message: string }> {
  if (!isAccountAllowed(event, options.allowedAccounts, options.serverUsername)) {
    return { status: "ignored", message: "Played by another user" };
  }
  if (
    event.positionSeconds < MIN_PROGRESS_SECONDS ||
    event.positionSeconds > event.durationSeconds * MAX_PROGRESS_FRACTION
  ) {
    return { status: "ignored", message: "Position outside the trackable range" };
  }

  try {
    const resolved = await resolveTarget(event, userId, provider);
    if (!resolved.ok) {
      log.debug(`Playback progress not saved for "${event.title}": ${resolved.logMessage}`);
      return { status: resolved.status, message: resolved.message };
    }
    const target = resolved.target;
    upsertPlaybackProgress({
      userId,
      titleId: target.titleId,
      episodeId: target.kind === "episode" ? target.episodeId : null,
      positionSeconds: event.positionSeconds,
      durationSeconds: event.durationSeconds,
      source: provider,
    });
    log.debug(
      `Saved ${provider} progress for "${event.title}": ${event.positionSeconds}/${event.durationSeconds}s`,
    );
    return { status: "success", message: "Progress saved" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log.warn(`Failed to save playback progress for "${event.title}": ${message}`);
    return { status: "error", message };
  }
}
