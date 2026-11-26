import type {
  AvailabilityOffer,
  CastMember,
  Episode,
  ResolvedTitle,
  Season,
} from "@sofa/api/schemas";
import {
  batchUpsertEpisodes,
  ensureBrowseTitlesTransaction,
  getAvailabilityOffersForTitle,
  getEpisodesBySeasonIds,
  getEpisodesNeedingStillHash,
  getExistingSeasonInfo,
  getOldEpisodeStills,
  getSeasonEpisodesWithHashes,
  getSeasonsForTitle,
  getTitleByTmdbIdAndType,
  getTitleGenres,
  getTitlesNeedingPosterHash,
  hasRecommendationsForTitle,
  hasSeasonForTitle,
  insertTitleReturning,
  markEnrichmentChecked,
  nullifyEpisodeThumbHash,
  nullifySeasonThumbHash,
  updateTitleFields,
  updateTrailerKey,
  upsertGenresTransaction,
  upsertRecommendationsTransaction,
  upsertSeasonReturning,
} from "@sofa/db/queries/metadata";
import { getTitleById } from "@sofa/db/queries/title";
import { getUserPlatformIds } from "@sofa/db/queries/user-platforms";
import type { titles } from "@sofa/db/schema";
import { createLogger } from "@sofa/logger";
import type { TmdbMovieDetails, TmdbTvDetails, TmdbVideo } from "@sofa/tmdb/client";
import {
  getEpisodeGroupDetails,
  getMovieDetails,
  getRecommendations,
  getSimilar,
  getTvDetails,
  getTvEpisodeGroups,
  getTvSeasonDetails,
  getVideos,
} from "@sofa/tmdb/client";
import { tmdbImageUrl } from "@sofa/tmdb/image";

import { refreshAvailability } from "./availability";
import { extractAndStoreColors, parseColorPalette } from "./colors";
import { mapWithConcurrency } from "./concurrency";
import { getCastForTitle, refreshCredits } from "./credits";
import {
  cacheEpisodeStills,
  cacheImagesForTitle,
  deleteOrphanedImage,
  imageCacheEnabled,
  loadImageBuffer,
} from "./image-cache";
import { getMetadataLanguageChangedAt } from "./metadata-language";
import { generateProviderUrl } from "./providers";
import {
  generateEpisodeThumbHash,
  generateSeasonThumbHash,
  generateTitleBackdropThumbHash,
  generateTitlePosterThumbHash,
} from "./thumbhash";

const log = createLogger("metadata");

/** After an empty TMDB answer, wait this long before asking again. */
const EMPTY_ENRICHMENT_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

function checkedRecently(at: Date | null | undefined): boolean {
  return !!at && Date.now() - at.getTime() < EMPTY_ENRICHMENT_RECHECK_MS;
}

const THUMBHASH_CONCURRENCY = 4;

export function updateTitleWithArtInvalidation(
  title: Pick<
    typeof titles.$inferSelect,
    "id" | "posterPath" | "backdropPath" | "posterThumbHash" | "backdropThumbHash" | "colorPalette"
  >,
  values: Partial<typeof titles.$inferInsert>,
) {
  const nextPosterPath = Object.hasOwn(values, "posterPath")
    ? (values.posterPath ?? null)
    : title.posterPath;
  const nextBackdropPath = Object.hasOwn(values, "backdropPath")
    ? (values.backdropPath ?? null)
    : title.backdropPath;

  const posterPathChanged = nextPosterPath !== title.posterPath;
  const backdropPathChanged = nextBackdropPath !== title.backdropPath;

  updateTitleFields(title.id, {
    ...values,
    ...(posterPathChanged
      ? {
          posterThumbHash: null,
          colorPalette: null,
        }
      : {}),
    ...(backdropPathChanged
      ? {
          backdropThumbHash: null,
        }
      : {}),
  });

  if (posterPathChanged) deleteOrphanedImage("posters", title.posterPath);
  if (backdropPathChanged) deleteOrphanedImage("backdrops", title.backdropPath);
}

/** @internal */
export function extractMovieContentRating(movie: TmdbMovieDetails): string | null {
  const us = movie.release_dates?.results?.find((r) => r.iso_3166_1 === "US");
  if (!us) return null;
  for (const rd of us.release_dates ?? []) {
    if (rd.certification) return rd.certification;
  }
  return null;
}

/** @internal */
export function extractTvContentRating(show: TmdbTvDetails): string | null {
  const us = show.content_ratings?.results?.find((r) => r.iso_3166_1 === "US");
  return us?.rating || null;
}

/** Title columns derived from TMDB TV details (everything except lastFetchedAt). */
function tvTitleFields(show: TmdbTvDetails) {
  return {
    title: show.name,
    originalTitle: show.original_name,
    overview: show.overview,
    firstAirDate: show.first_air_date || null,
    posterPath: show.poster_path,
    backdropPath: show.backdrop_path,
    popularity: show.popularity,
    voteAverage: show.vote_average,
    voteCount: show.vote_count,
    status: show.status,
    contentRating: extractTvContentRating(show),
    tvdbId: show.external_ids?.tvdb_id ?? null,
    imdbId: show.external_ids?.imdb_id ?? null,
    originalLanguage: show.original_language ?? null,
  };
}

/** Fire-and-forget enrichment tasks (availability, recommendations, art, credits, trailer) */
function fireAndForgetEnrichment(
  titleId: string,
  posterPath: string | null | undefined,
  backdropPath: string | null | undefined,
  type: "movie" | "tv",
) {
  refreshAvailability(titleId).catch((err) => log.warn("Availability enrichment failed:", err));
  refreshRecommendations(titleId).catch((err) =>
    log.warn("Recommendations enrichment failed:", err),
  );
  syncTitleArt(titleId, posterPath, backdropPath, type).catch((err) =>
    log.warn("Cache/thumbhash failed:", err),
  );
  refreshCredits(titleId).catch((err) => log.warn("Credits enrichment failed:", err));
  refreshTrailer(titleId).catch((err) => log.warn("Trailer enrichment failed:", err));
}

type ImportResult = ReturnType<typeof fetchTitleByTmdbId>;

/** In-flight import promises keyed by `${tmdbId}-${type}` — coalesces concurrent calls */
const inflightImports = new Map<string, ImportResult>();

export function getOrFetchTitleByTmdbId(tmdbId: number, type: "movie" | "tv"): ImportResult {
  const key = `${tmdbId}-${type}`;
  const inflight = inflightImports.get(key);
  if (inflight) {
    log.debug(`Import already in-flight for ${type} TMDB ${tmdbId}, coalescing`);
    return inflight;
  }

  const promise = fetchTitleByTmdbId(tmdbId, type).finally(() => {
    inflightImports.delete(key);
  }) as ImportResult;
  inflightImports.set(key, promise);
  return promise;
}

async function fetchTitleByTmdbId(tmdbId: number, type: "movie" | "tv") {
  log.debug(`Importing ${type} TMDB ${tmdbId}`);

  const existing = getTitleByTmdbIdAndType(tmdbId, type);
  if (existing) {
    // Shell title — upgrade to full import
    if (!existing.lastFetchedAt) {
      if (type === "movie") {
        const movie = await getMovieDetails(tmdbId);
        updateTitleWithArtInvalidation(existing, {
          title: movie.title ?? existing.title,
          originalTitle: movie.original_title,
          overview: movie.overview,
          releaseDate: movie.release_date || null,
          posterPath: movie.poster_path,
          backdropPath: movie.backdrop_path,
          popularity: movie.popularity,
          voteAverage: movie.vote_average,
          voteCount: movie.vote_count,
          status: movie.status,
          contentRating: extractMovieContentRating(movie),
          imdbId: movie.imdb_id ?? null,
          originalLanguage: movie.original_language ?? null,
          runtimeMinutes: movie.runtime ?? null,
          lastFetchedAt: new Date(),
        });
        upsertGenresTransaction(existing.id, movie.genres ?? []);
        fireAndForgetEnrichment(existing.id, movie.poster_path, movie.backdrop_path, "movie");
        return getTitleById(existing.id);
      }

      // TV shell — fetch details + children
      const show = await getTvDetails(tmdbId);
      updateTitleWithArtInvalidation(existing, {
        ...tvTitleFields(show),
        lastFetchedAt: new Date(),
      });
      upsertGenresTransaction(existing.id, show.genres ?? []);
      await refreshTvChildren(existing.id, tmdbId, show.number_of_seasons);
      fireAndForgetEnrichment(existing.id, show.poster_path, show.backdrop_path, "tv");
      return getTitleById(existing.id);
    }

    // For fully-fetched TV shows, check if seasons are missing (e.g. prior failure)
    if (existing.type === "tv") {
      if (!hasSeasonForTitle(existing.id)) {
        const show = await getTvDetails(tmdbId);
        upsertGenresTransaction(existing.id, show.genres ?? []);
        await refreshTvChildren(existing.id, tmdbId, show.number_of_seasons);
        fireAndForgetEnrichment(existing.id, show.poster_path, show.backdrop_path, "tv");
        return getTitleById(existing.id);
      }
    }

    return existing;
  }

  const now = new Date();

  if (type === "movie") {
    const movie = await getMovieDetails(tmdbId);
    const row = insertTitleReturning({
      tmdbId: movie.id,
      type: "movie",
      title: movie.title ?? "",
      originalTitle: movie.original_title,
      overview: movie.overview,
      releaseDate: movie.release_date || null,
      posterPath: movie.poster_path,
      backdropPath: movie.backdrop_path,
      popularity: movie.popularity,
      voteAverage: movie.vote_average,
      voteCount: movie.vote_count,
      status: movie.status,
      contentRating: extractMovieContentRating(movie),
      imdbId: movie.imdb_id ?? null,
      originalLanguage: movie.original_language ?? null,
      runtimeMinutes: movie.runtime ?? null,
      lastFetchedAt: now,
    });
    if (!row) return undefined;
    upsertGenresTransaction(row.id, movie.genres ?? []);
    fireAndForgetEnrichment(row.id, movie.poster_path, movie.backdrop_path, "movie");
    log.info(`Imported movie "${movie.title}" (TMDB ${tmdbId})`);
    return row;
  }

  const show = await getTvDetails(tmdbId);
  const row = insertTitleReturning({
    tmdbId: show.id,
    tvdbId: show.external_ids?.tvdb_id ?? null,
    type: "tv",
    title: show.name ?? "",
    originalTitle: show.original_name,
    overview: show.overview,
    firstAirDate: show.first_air_date || null,
    posterPath: show.poster_path,
    backdropPath: show.backdrop_path,
    popularity: show.popularity,
    voteAverage: show.vote_average,
    voteCount: show.vote_count,
    status: show.status,
    contentRating: extractTvContentRating(show),
    imdbId: show.external_ids?.imdb_id ?? null,
    originalLanguage: show.original_language ?? null,
    lastFetchedAt: now,
  });
  if (!row) return undefined;
  upsertGenresTransaction(row.id, show.genres ?? []);

  await refreshTvChildren(row.id, tmdbId, show.number_of_seasons);
  fireAndForgetEnrichment(row.id, show.poster_path, show.backdrop_path, "tv");
  log.info(`Imported TV show "${show.name}" (TMDB ${tmdbId})`);
  return row;
}

export async function refreshTitle(titleId: string) {
  const title = getTitleById(titleId);
  if (!title) return null;

  const now = new Date();

  if (title.type === "movie") {
    const movie = await getMovieDetails(title.tmdbId);
    updateTitleWithArtInvalidation(title, {
      title: movie.title,
      originalTitle: movie.original_title,
      overview: movie.overview,
      releaseDate: movie.release_date || null,
      posterPath: movie.poster_path,
      backdropPath: movie.backdrop_path,
      popularity: movie.popularity,
      voteAverage: movie.vote_average,
      voteCount: movie.vote_count,
      status: movie.status,
      contentRating: extractMovieContentRating(movie),
      imdbId: movie.imdb_id ?? null,
      originalLanguage: movie.original_language ?? null,
      runtimeMinutes: movie.runtime ?? null,
      lastFetchedAt: now,
    });
    upsertGenresTransaction(titleId, movie.genres ?? []);
  } else {
    const show = await getTvDetails(title.tmdbId);
    updateTitleWithArtInvalidation(title, {
      ...tvTitleFields(show),
      lastFetchedAt: now,
    });
    upsertGenresTransaction(titleId, show.genres ?? []);
    // After a metadata language change, refetch every season (not just the latest ones).
    const languageChangedAt = getMetadataLanguageChangedAt();
    const fullRefresh =
      languageChangedAt != null &&
      (!title.lastFetchedAt || title.lastFetchedAt.getTime() < languageChangedAt.getTime());
    const onlySeasons = fullRefresh
      ? undefined
      : seasonsToRefresh(
          show.status ?? null,
          show.number_of_seasons,
          getSeasonsForTitle(titleId).map((s) => s.seasonNumber),
        );
    await refreshTvChildren(titleId, title.tmdbId, show.number_of_seasons, { onlySeasons });
  }

  const updated = getTitleById(titleId);
  if (updated) {
    syncTitleArt(
      updated.id,
      updated.posterPath,
      updated.backdropPath,
      updated.type as "movie" | "tv",
    ).catch((err) => log.debug("Cache/thumbhash failed:", err));
    refreshTrailer(updated.id).catch((err) => log.debug("Trailer enrichment failed:", err));
    refreshCredits(updated.id).catch((err) => log.debug("Credits enrichment failed:", err));
  }
  return updated;
}

const RETURNING_TV_STATUSES = new Set(["Returning Series", "In Production"]);

/**
 * Seasons worth re-fetching for a show we already have: for returning shows, the two latest
 * plus any season never stored; otherwise every season.
 */
export function seasonsToRefresh(
  status: string | null,
  numberOfSeasons: number,
  storedSeasonNumbers: number[],
): number[] | undefined {
  if (!status || !RETURNING_TV_STATUSES.has(status) || storedSeasonNumbers.length === 0) {
    return undefined; // all seasons
  }
  const stored = new Set(storedSeasonNumbers);
  const result: number[] = [];
  for (let sn = 1; sn <= numberOfSeasons; sn++) {
    if (sn >= numberOfSeasons - 1 || !stored.has(sn)) result.push(sn);
  }
  return result;
}

export async function refreshTvChildren(
  titleId: string,
  tmdbId: number,
  numberOfSeasons: number,
  options?: { onlySeasons?: number[] },
) {
  // Fetch seasons with limited concurrency to stay within TMDB's 40 req/s limit
  const allSeasons = Array.from({ length: numberOfSeasons }, (_, i) => i + 1);
  const only = options?.onlySeasons;
  const seasonNumbers = only ? allSeasons.filter((sn) => only.includes(sn)) : allSeasons;
  const fetched = await mapWithConcurrency(
    seasonNumbers,
    (sn) => getTvSeasonDetails(tmdbId, sn),
    5,
  );

  const now = new Date();

  for (let i = 0; i < seasonNumbers.length; i++) {
    const result = fetched[i];
    const sn = seasonNumbers[i];
    if (result.status === "rejected") {
      log.error(`Failed to fetch season ${sn} for TMDB ${tmdbId}:`, result.reason);
      continue;
    }

    const seasonData = result.value;

    const existingSeason = getExistingSeasonInfo(titleId, sn);

    const seasonRow = upsertSeasonReturning({
      titleId,
      seasonNumber: seasonData.season_number,
      name: seasonData.name ?? null,
      overview: seasonData.overview ?? null,
      posterPath: seasonData.poster_path ?? null,
      airDate: seasonData.air_date ?? null,
      lastFetchedAt: now,
    });

    // Snapshot existing episode still paths before upsert so we can detect changes
    const oldEpStills = getOldEpisodeStills(existingSeason?.id ?? seasonRow.id);

    // Batch all episode upserts in a single transaction per season
    const eps = seasonData.episodes ?? [];
    batchUpsertEpisodes(
      seasonRow.id,
      eps.map((ep) => ({
        episode_number: ep.episode_number,
        name: ep.name ?? null,
        overview: ep.overview ?? null,
        still_path: ep.still_path ?? null,
        air_date: ep.air_date ?? null,
        runtime: ep.runtime,
      })),
    );

    // Clear stale hashes when image paths change during the upsert.
    // Full hash (re)generation is handled by syncTitleArt() after
    // cache warming, so we only need to null out stale values here.
    if ((existingSeason?.posterPath ?? null) !== (seasonData.poster_path ?? null)) {
      nullifySeasonThumbHash(seasonRow.id);
      deleteOrphanedImage("posters", existingSeason?.posterPath ?? null);
    }
    const seasonEps = getSeasonEpisodesWithHashes(seasonRow.id);
    for (const ep of seasonEps) {
      const oldStill = oldEpStills.get(ep.episodeNumber);
      if (oldStill !== ep.stillPath) {
        if (ep.stillThumbHash) nullifyEpisodeThumbHash(ep.id);
        deleteOrphanedImage("stills", oldStill ?? null);
      }
    }
  }
}

export async function refreshRecommendations(titleId: string) {
  const title = getTitleById(titleId);
  if (!title) return;

  const now = new Date();

  // Fetch both recommendations and similar
  const [recs, similar] = await Promise.all([
    getRecommendations(title.tmdbId, title.type),
    getSimilar(title.tmdbId, title.type),
  ]);
  markEnrichmentChecked(titleId, "recommendations");

  const recsResults = recs.results ?? [];
  const similarResults = similar.results ?? [];

  log.debug(
    `Fetched ${recsResults.length} recommendations and ${similarResults.length} similar for title ${titleId}`,
  );

  // Collect all valid results with their source/rank
  interface RecItem {
    result: (typeof recsResults)[number];
    type: "movie" | "tv";
    source: "tmdb_recommendations" | "tmdb_similar";
    rank: number;
  }
  const allItems: RecItem[] = [];
  for (let i = 0; i < recsResults.length && i < 20; i++) {
    const r = recsResults[i];
    const type = r.media_type ?? title.type;
    if (type === "movie" || type === "tv") {
      allItems.push({
        result: r,
        type,
        source: "tmdb_recommendations",
        rank: i + 1,
      });
    }
  }
  for (let i = 0; i < similarResults.length && i < 20; i++) {
    const r = similarResults[i];
    const type = r.media_type ?? title.type;
    if (type === "movie" || type === "tv") {
      allItems.push({ result: r, type, source: "tmdb_similar", rank: i + 1 });
    }
  }

  if (allItems.length === 0) return;

  const uniqueTitles = new Map<
    number,
    {
      tmdbId: number;
      type: "movie" | "tv";
      title: string;
      originalTitle: string | null;
      overview: string | null;
      releaseDate: string | null;
      firstAirDate: string | null;
      posterPath: string | null;
      backdropPath: string | null;
      popularity: number | null;
      voteAverage: number | null;
      voteCount: number | null;
    }
  >();
  for (const item of allItems) {
    if (uniqueTitles.has(item.result.id)) continue;
    uniqueTitles.set(item.result.id, {
      tmdbId: item.result.id,
      type: item.type,
      title: item.result.title ?? item.result.name ?? "Unknown",
      originalTitle: item.result.original_title ?? item.result.original_name ?? null,
      overview: item.result.overview ?? null,
      releaseDate: item.result.release_date ?? null,
      firstAirDate: item.result.first_air_date ?? null,
      posterPath: item.result.poster_path ?? null,
      backdropPath: item.result.backdrop_path ?? null,
      popularity: item.result.popularity ?? null,
      voteAverage: item.result.vote_average ?? null,
      voteCount: item.result.vote_count ?? null,
    });
  }

  const titleIdMap = upsertRecommendationsTransaction(
    titleId,
    uniqueTitles,
    allItems.map((item) => ({
      tmdbId: item.result.id,
      source: item.source,
      rank: item.rank,
    })),
    now,
  );

  // Fire-and-forget thumbhash generation for recommendation titles missing one
  const recTitleIds = [
    ...new Set(allItems.map((i) => titleIdMap.get(i.result.id)).filter(Boolean)),
  ] as string[];
  if (recTitleIds.length > 0) {
    const needingHash = getTitlesNeedingPosterHash(recTitleIds);
    for (const t of needingHash) {
      generateTitlePosterThumbHash(t.id, t.posterPath).catch((err) =>
        log.debug("Recommendation poster thumbhash failed:", err),
      );
    }
  }
}

export type EpisodeGroupMapping = NonNullable<(typeof titles.$inferSelect)["episodeGroup"]>;

/** Prefix for the IDs of display-only seasons built from an episode group. */
export const GROUP_SEASON_ID_PREFIX = "group:";

/**
 * Re-arrange a show's TMDB seasons into an episode group's seasons (display only: episodes keep
 * their IDs, so watches are unaffected). Episodes the group leaves out stay in their TMDB season.
 */
export function applyEpisodeGroup(
  titleId: string,
  tmdbSeasons: Season[],
  group: EpisodeGroupMapping,
): Season[] {
  const byNumber = new Map<string, Episode>();
  for (const season of tmdbSeasons) {
    for (const ep of season.episodes) {
      byNumber.set(`${season.seasonNumber}:${ep.episodeNumber}`, ep);
    }
  }

  const used = new Set<string>();
  const grouped: Season[] = [];
  for (const groupSeason of [...group.seasons].sort((a, b) => a.order - b.order)) {
    const episodes: Episode[] = [];
    for (const [seasonNumber, episodeNumber] of groupSeason.episodes) {
      const key = `${seasonNumber}:${episodeNumber}`;
      const ep = byNumber.get(key);
      if (!ep || used.has(key)) continue;
      used.add(key);
      episodes.push({ ...ep, episodeNumber: episodes.length + 1 });
    }
    if (episodes.length === 0) continue;
    grouped.push({
      id: `${GROUP_SEASON_ID_PREFIX}${titleId}:${groupSeason.order}`,
      seasonNumber: groupSeason.order,
      name: groupSeason.name,
      episodes,
    });
  }

  if (grouped.length === 0) return tmdbSeasons;

  // Keep anything the group doesn't cover (e.g. episodes newer than the group) visible.
  for (const season of tmdbSeasons) {
    const leftover = season.episodes.filter(
      (ep) => !used.has(`${season.seasonNumber}:${ep.episodeNumber}`),
    );
    if (leftover.length > 0 && leftover.length === season.episodes.length) grouped.push(season);
  }
  return grouped;
}

/** Fetch seasons from the DB, building the Season[] structure. */
/**
 * Episode IDs of a season from an alternative order ("group:<titleId>:<order>"), which only
 * exists for display. Lets clients that mark whole seasons (e.g. the phone app) work with it.
 */
export function episodeIdsForGroupSeason(seasonId: string): string[] | null {
  if (!seasonId.startsWith(GROUP_SEASON_ID_PREFIX)) return null;
  const rest = seasonId.slice(GROUP_SEASON_ID_PREFIX.length);
  const titleId = rest.slice(0, rest.lastIndexOf(":"));
  const season = fetchSeasonsFromDb(titleId).find((s) => s.id === seasonId);
  return season ? season.episodes.map((ep) => ep.id) : [];
}

function fetchSeasonsFromDb(titleId: string): Season[] {
  const tmdbSeasons = fetchTmdbSeasonsFromDb(titleId);
  const group = getTitleById(titleId)?.episodeGroup;
  return group ? applyEpisodeGroup(titleId, tmdbSeasons, group) : tmdbSeasons;
}

/** The alternative season orderings TMDB has for a show, and which one is in use. */
export async function listEpisodeGroups(titleId: string) {
  const title = getTitleById(titleId);
  if (!title || title.type !== "tv") return { current: null, groups: [] };
  const groups = await getTvEpisodeGroups(title.tmdbId);
  return {
    current: title.episodeGroup
      ? { id: title.episodeGroup.id, name: title.episodeGroup.name }
      : null,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      seasonCount: g.group_count,
      episodeCount: g.episode_count,
    })),
  };
}

/** Display a show's seasons using a TMDB episode group (null = TMDB's own seasons). */
export async function setEpisodeGroup(titleId: string, groupId: string | null) {
  const title = getTitleById(titleId);
  if (!title || title.type !== "tv") throw new Error("Not a TV show");
  if (!groupId) {
    updateTitleFields(titleId, { episodeGroup: null });
    return { current: null };
  }
  const details = await getEpisodeGroupDetails(groupId);
  const mapping: EpisodeGroupMapping = {
    id: details.id,
    name: details.name,
    seasons: (details.groups ?? []).map((g) => ({
      name: g.name,
      order: g.order,
      episodes: [...(g.episodes ?? [])]
        .sort((a, b) => a.order - b.order)
        .map((e) => [e.season_number, e.episode_number] as [number, number]),
    })),
  };
  updateTitleFields(titleId, { episodeGroup: mapping });
  return { current: { id: mapping.id, name: mapping.name } };
}

/** TMDB's own seasons from the DB. */
function fetchTmdbSeasonsFromDb(titleId: string): Season[] {
  const seasonRows = getSeasonsForTitle(titleId);

  if (seasonRows.length === 0) return [];

  const seasonIds = seasonRows.map((s) => s.id);
  const allEps = getEpisodesBySeasonIds(seasonIds);

  const epsBySeason = new Map<string, Episode[]>();
  for (const ep of allEps) {
    const arr = epsBySeason.get(ep.seasonId) ?? [];
    arr.push({
      id: ep.id,
      episodeNumber: ep.episodeNumber,
      name: ep.name,
      overview: ep.overview,
      stillPath: tmdbImageUrl(ep.stillPath, "stills"),
      stillThumbHash: ep.stillThumbHash,
      airDate: ep.airDate,
      runtimeMinutes: ep.runtimeMinutes,
    });
    epsBySeason.set(ep.seasonId, arr);
  }

  return seasonRows.map((s) => ({
    id: s.id,
    seasonNumber: s.seasonNumber,
    name: s.name,
    episodes: epsBySeason.get(s.id) ?? [],
  }));
}

/**
 * Ensure a TV title is fully hydrated (seasons/episodes fetched from TMDB).
 * Returns the hydrated seasons data.
 */
export async function ensureTvHydrated(titleId: string): Promise<Season[]> {
  const title = getTitleById(titleId);
  if (!title || title.type !== "tv") return [];

  const { tmdbId } = title;

  // Shell title: fetch details + children
  if (!title.lastFetchedAt) {
    try {
      const show = await getTvDetails(tmdbId);
      updateTitleWithArtInvalidation(title, {
        ...tvTitleFields(show),
        lastFetchedAt: new Date(),
      });
      upsertGenresTransaction(titleId, show.genres ?? []);
      await refreshTvChildren(titleId, tmdbId, show.number_of_seasons);
    } catch (err) {
      log.debug(`Failed to hydrate shell TV title ${titleId}:`, err);
    }
  }

  let result = fetchSeasonsFromDb(titleId);

  // Retry hydration when seasons are still missing
  if (result.length === 0) {
    try {
      const show = await getTvDetails(tmdbId);
      await refreshTvChildren(titleId, tmdbId, show.number_of_seasons);
      result = fetchSeasonsFromDb(titleId);
    } catch (err) {
      log.debug(`Failed to backfill missing seasons for title ${titleId}:`, err);
    }
  }

  return result;
}

/**
 * Ensure a title has all enrichment data. Accepts already-read data to avoid
 * redundant queries — only does lightweight existence checks for data not
 * already loaded (recommendations). Returns true if any work was performed.
 */
async function ensureEnriched(
  titleId: string,
  title: typeof titles.$inferSelect,
  existing: { hasCast: boolean; hasAvailability: boolean },
): Promise<boolean> {
  const tasks: Promise<unknown>[] = [];

  if (!existing.hasCast && !checkedRecently(title.creditsCheckedAt)) {
    tasks.push(
      refreshCredits(titleId).catch((err) => log.debug("Credits enrichment failed:", err)),
    );
  }

  if (!existing.hasAvailability && !checkedRecently(title.availabilityCheckedAt)) {
    tasks.push(
      refreshAvailability(titleId).catch((err) =>
        log.debug("Availability enrichment failed:", err),
      ),
    );
  }

  // Recommendations are loaded separately (Suspense), so check here
  if (!hasRecommendationsForTitle(titleId) && !checkedRecently(title.recommendationsCheckedAt)) {
    tasks.push(
      refreshRecommendations(titleId).catch((err) =>
        log.debug("Recommendations enrichment failed:", err),
      ),
    );
  }

  const needsTitleArtSync =
    (!title.posterPath && (!!title.posterThumbHash || !!title.colorPalette)) ||
    (!!title.posterPath && (!title.posterThumbHash || !title.colorPalette)) ||
    (!title.backdropPath && !!title.backdropThumbHash) ||
    (!!title.backdropPath && !title.backdropThumbHash);

  if (needsTitleArtSync) {
    tasks.push(
      syncTitleArt(
        titleId,
        title.posterPath,
        title.backdropPath,
        title.type as "movie" | "tv",
      ).catch((err) => log.debug("Title art enrichment failed:", err)),
    );
  }

  if (!title.trailerVideoKey && !checkedRecently(title.trailerCheckedAt)) {
    tasks.push(
      refreshTrailer(titleId).catch((err) => log.debug("Trailer enrichment failed:", err)),
    );
  }

  if (tasks.length > 0) {
    log.debug(`Backfilling ${tasks.length} enrichment task(s) for "${title.title}"`);
    await Promise.all(tasks);
    return true;
  }
  return false;
}

const STREAM_TYPES = new Set(["flatrate", "free", "ads"]);
const STREAM_PRIORITY: Record<string, number> = { flatrate: 0, free: 1, ads: 2 };
const PURCHASE_PRIORITY: Record<string, number> = { rent: 0, buy: 1 };

function readAvailability(
  titleId: string,
  titleName: string,
  userPlatformIds?: Set<string>,
): AvailabilityOffer[] {
  const raw = getAvailabilityOffersForTitle(titleId);

  // Group by platformId to deduplicate
  const byPlatform = new Map<string, (typeof raw)[number][]>();
  for (const offer of raw) {
    let list = byPlatform.get(offer.platformId);
    if (!list) {
      list = [];
      byPlatform.set(offer.platformId, list);
    }
    list.push(offer);
  }

  const result: AvailabilityOffer[] = [];

  for (const [platformId, offers] of byPlatform) {
    const streamOffers = offers.filter((o) => STREAM_TYPES.has(o.offerType));
    const purchaseOffers = offers.filter((o) => !STREAM_TYPES.has(o.offerType));

    // Emit one "stream" entry per platform (best offer type wins)
    if (streamOffers.length > 0) {
      const best = streamOffers.sort(
        (a, b) => (STREAM_PRIORITY[a.offerType] ?? 99) - (STREAM_PRIORITY[b.offerType] ?? 99),
      )[0];
      result.push({
        platformId,
        providerName: best.providerName,
        logoPath: tmdbImageUrl(best.logoPath, "logos"),
        offerType: "stream",
        watchUrl: generateProviderUrl(best.urlTemplate, titleName),
        isUserSubscribed: userPlatformIds ? userPlatformIds.has(platformId) : false,
      });
    }

    // Emit one "purchase" entry per platform (rent preferred over buy)
    if (purchaseOffers.length > 0) {
      const best = purchaseOffers.sort(
        (a, b) => (PURCHASE_PRIORITY[a.offerType] ?? 99) - (PURCHASE_PRIORITY[b.offerType] ?? 99),
      )[0];
      result.push({
        platformId,
        providerName: best.providerName,
        logoPath: tmdbImageUrl(best.logoPath, "logos"),
        offerType: "purchase",
        watchUrl: generateProviderUrl(best.urlTemplate, titleName),
        isUserSubscribed: userPlatformIds ? userPlatformIds.has(platformId) : false,
      });
    }
  }

  return result;
}

/** In-flight language refreshes, so repeated visits don't start duplicate downloads. */
const languageRefreshes = new Map<string, Promise<void>>();

function fetchedBeforeLanguageChange(lastFetchedAt: Date): boolean {
  const changedAt = getMetadataLanguageChangedAt();
  return changedAt != null && lastFetchedAt < changedAt;
}

function refreshInNewLanguage(titleId: string): Promise<void> {
  const inflight = languageRefreshes.get(titleId);
  if (inflight) return inflight;
  const promise = refreshTitle(titleId)
    .then(() => undefined)
    .catch((err) => log.debug(`Language refresh failed for ${titleId}:`, err))
    .finally(() => languageRefreshes.delete(titleId));
  languageRefreshes.set(titleId, promise);
  return promise;
}

export async function getOrFetchTitle(
  id: string,
  userId?: string,
): Promise<{
  title: ResolvedTitle;
  seasons: Season[];
  episodeOrder: { id: string; name: string } | null;
  availability: AvailabilityOffer[];
  cast: CastMember[];
} | null> {
  let title = getTitleById(id);
  if (!title) return null;

  // If this is a shell movie title, fetch full details now (movies are fast)
  if (title.type === "movie" && !title.lastFetchedAt) {
    try {
      const movie = await getMovieDetails(title.tmdbId);
      updateTitleWithArtInvalidation(title, {
        title: movie.title,
        originalTitle: movie.original_title,
        overview: movie.overview,
        releaseDate: movie.release_date || null,
        posterPath: movie.poster_path,
        backdropPath: movie.backdrop_path,
        popularity: movie.popularity,
        voteAverage: movie.vote_average,
        voteCount: movie.vote_count,
        status: movie.status,
        contentRating: extractMovieContentRating(movie),
        imdbId: movie.imdb_id ?? null,
        originalLanguage: movie.original_language ?? null,
        runtimeMinutes: movie.runtime ?? null,
        lastFetchedAt: new Date(),
      });
      upsertGenresTransaction(id, movie.genres ?? []);
      title = getTitleById(id) ?? title;
    } catch (err) {
      log.debug(`Failed to hydrate shell movie title ${id}:`, err);
    }
  }

  // Fetched before the metadata language changed: re-download it in the new language. Movies are
  // one request, so wait and show the translation right away; shows (all seasons) update in the
  // background and appear translated on the next visit.
  if (title.lastFetchedAt && fetchedBeforeLanguageChange(title.lastFetchedAt)) {
    const refresh = refreshInNewLanguage(id);
    if (title.type === "movie") {
      await refresh;
      title = getTitleById(id) ?? title;
    }
  }

  // For TV titles, hydrate seasons inline if needed
  let titleSeasons: Season[] = [];
  if (title.type === "tv") {
    titleSeasons = title.lastFetchedAt ? fetchSeasonsFromDb(id) : [];
    if (titleSeasons.length === 0) {
      titleSeasons = await ensureTvHydrated(id);
      title = getTitleById(id) ?? title;
    }
  }

  // Read enrichment data, then backfill anything missing
  const userPlatformIdSet = userId ? new Set(getUserPlatformIds(userId)) : undefined;
  let availability = readAvailability(title.id, title.title, userPlatformIdSet);
  let cast = getCastForTitle(id);

  if (title.lastFetchedAt) {
    const enriched = await ensureEnriched(id, title, {
      hasCast: cast.length > 0,
      hasAvailability: availability.length > 0,
    });
    if (enriched) {
      // Re-read only what was missing
      if (cast.length === 0) cast = getCastForTitle(id);
      if (availability.length === 0)
        availability = readAvailability(title.id, title.title, userPlatformIdSet);
      title = getTitleById(id) ?? title;
    }
  }

  const palette = parseColorPalette(title.colorPalette);

  const titleGenreRows = getTitleGenres(id);

  const resolvedTitle: ResolvedTitle = {
    id: title.id,
    tmdbId: title.tmdbId,
    type: title.type as "movie" | "tv",
    title: title.title,
    originalTitle: title.originalTitle,
    overview: title.overview,
    releaseDate: title.releaseDate,
    firstAirDate: title.firstAirDate,
    posterPath: tmdbImageUrl(title.posterPath, "posters"),
    posterThumbHash: title.posterThumbHash,
    backdropPath: tmdbImageUrl(title.backdropPath, "backdrops"),
    backdropThumbHash: title.backdropThumbHash,
    popularity: title.popularity,
    voteAverage: title.voteAverage,
    voteCount: title.voteCount,
    status: title.status,
    contentRating: title.contentRating,
    imdbId: title.imdbId,
    tvdbId: title.tvdbId,
    originalLanguage: title.originalLanguage,
    runtimeMinutes: title.runtimeMinutes,
    colorPalette: palette,
    trailerVideoKey: title.trailerVideoKey,
    genres: titleGenreRows.map((r) => r.name),
  };

  return {
    title: resolvedTitle,
    seasons: titleSeasons,
    episodeOrder: title.episodeGroup
      ? { id: title.episodeGroup.id, name: title.episodeGroup.name }
      : null,
    availability,
    cast,
  };
}

export function pickBestTrailer(videos: TmdbVideo[]): string | null {
  let candidates = videos.filter((v) => v.site === "YouTube");
  if (candidates.length === 0) return null;

  // Prefer English, fall back to any language
  const english = candidates.filter((v) => v.iso_639_1 === "en");
  if (english.length > 0) candidates = english;

  const byDate = (a: TmdbVideo, b: TmdbVideo) =>
    (b.published_at ?? "").localeCompare(a.published_at ?? "");

  // Tier 1: official trailers
  const officialTrailers = candidates
    .filter((v) => v.official && v.type === "Trailer")
    .sort(byDate);
  if (officialTrailers.length > 0) return officialTrailers[0].key ?? null;

  // Tier 2: any trailer
  const trailers = candidates.filter((v) => v.type === "Trailer").sort(byDate);
  if (trailers.length > 0) return trailers[0].key ?? null;

  // Tier 3: teasers
  const teasers = candidates.filter((v) => v.type === "Teaser").sort(byDate);
  if (teasers.length > 0) return teasers[0].key ?? null;

  return null;
}

export async function refreshTrailer(titleId: string) {
  const title = getTitleById(titleId);
  if (!title) return;

  try {
    const response = await getVideos(title.tmdbId, title.type);
    const key = pickBestTrailer(response.results ?? []);
    updateTrailerKey(titleId, key);
    markEnrichmentChecked(titleId, "trailer");
    log.debug(`Trailer for "${title.title}": ${key ? `YouTube ${key}` : "none found"}`);
  } catch (err) {
    log.debug(`Failed to fetch trailer for title ${titleId}:`, err);
  }
}

async function generateMissingTvChildThumbHashes(titleId: string) {
  const titleSeasons = getSeasonsForTitle(titleId);

  const work: (() => Promise<unknown>)[] = [];

  for (const s of titleSeasons) {
    if (s.posterPath && !s.posterThumbHash) {
      const posterPath = s.posterPath;
      work.push(() => generateSeasonThumbHash(s.id, posterPath));
    }
  }

  const seasonIds = titleSeasons.map((s) => s.id);
  if (seasonIds.length > 0) {
    const epsNeedingHash = getEpisodesNeedingStillHash(seasonIds);
    for (const ep of epsNeedingHash) {
      work.push(() => generateEpisodeThumbHash(ep.id, ep.stillPath));
    }
  }

  await mapWithConcurrency(work, (run) => run(), THUMBHASH_CONCURRENCY);
}

export async function syncTvChildArt(titleId: string, options?: { warmCache?: boolean }) {
  if (options?.warmCache !== false && imageCacheEnabled()) {
    await Promise.all([cacheImagesForTitle(titleId), cacheEpisodeStills(titleId)]);
  }

  await generateMissingTvChildThumbHashes(titleId);
}

/**
 * Warm the image cache for a title, then derive poster colors and thumbhashes.
 * Sequencing avoids duplicate TMDB downloads on cold caches. For TV, episode stills
 * and season/episode thumbhashes continue in the background after this resolves.
 */
async function syncTitleArt(
  titleId: string,
  posterPath: string | null | undefined,
  backdropPath: string | null | undefined,
  type: "movie" | "tv",
) {
  if (imageCacheEnabled()) {
    await cacheImagesForTitle(titleId);
  }

  const posterBuffer = posterPath ? await loadImageBuffer(posterPath, "posters") : undefined;

  // Title poster colors + thumbhash, then backdrop thumbhash
  await Promise.all([
    extractAndStoreColors(titleId, posterPath ?? null, posterBuffer),
    generateTitlePosterThumbHash(titleId, posterPath ?? null, posterBuffer),
    generateTitleBackdropThumbHash(titleId, backdropPath ?? null),
  ]);

  if (type === "tv") {
    // Episode stills and season/episode thumbhashes can number in the hundreds; callers
    // (often a title-page request) shouldn't wait for them.
    syncTvChildArt(titleId).catch((err) => log.debug("TV child art sync failed:", err));
  }
}

// ─── Browse batch upsert ─────────────────────────────────────

interface BrowseTitleInput {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  posterPath: string | null;
  backdropPath?: string | null;
  releaseDate?: string | null;
  firstAirDate?: string | null;
  overview?: string | null;
  popularity?: number | null;
  voteAverage?: number | null;
  voteCount?: number | null;
}

/**
 * Ensure every browse/search result has a local title row.
 * Inserts shell titles (`lastFetchedAt = null`) for new (tmdbId, type) pairs.
 * Returns a map keyed by `${tmdbId}-${type}` → { id, posterThumbHash }.
 */
export function ensureBrowseTitlesExist(
  items: BrowseTitleInput[],
): Map<string, { id: string; posterThumbHash: string | null }> {
  return ensureBrowseTitlesTransaction(items);
}
