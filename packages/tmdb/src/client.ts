import createClient, { type Middleware } from "openapi-fetch";

import { createLogger } from "@sofa/logger";

import { resolveTmdbBase } from "./config";
import type { operations, paths } from "./schema";

const log = createLogger("tmdb");

// ─── Schema-derived types ───────────────────────────────────────────

/** Extract the 200 JSON response body from an operation */
type OpResponse<K extends keyof operations> = operations[K] extends {
  responses: {
    200: { content: { "application/json": infer T } };
  };
}
  ? T
  : never;

// Search
export type TmdbSearchResponse = OpResponse<"search-multi">;
export type TmdbSearchResult = NonNullable<TmdbSearchResponse["results"]>[number];

// Movie details — augmented with append_to_response data
export type TmdbMovieDetails = OpResponse<"movie-details"> & {
  release_dates?: {
    results: NonNullable<OpResponse<"movie-release-dates">["results"]>;
  };
};

// TV details — augmented with append_to_response data
export type TmdbTvDetails = OpResponse<"tv-series-details"> & {
  content_ratings?: OpResponse<"tv-series-content-ratings">;
  external_ids?: OpResponse<"tv-series-external-ids">;
};

// Watch providers — manually defined because the schema types `results` as an
// object with literal country-code keys rather than Record<string, ...>, which
// makes dynamic lookups (e.g. results["US"]) impractical.
export interface TmdbProvider {
  logo_path?: string;
  provider_id: number;
  provider_name?: string;
  display_priority: number;
}

export interface TmdbWatchProviderRegion {
  link?: string;
  flatrate?: TmdbProvider[];
  rent?: TmdbProvider[];
  buy?: TmdbProvider[];
  free?: TmdbProvider[];
  ads?: TmdbProvider[];
}

export interface TmdbWatchProviderResponse {
  id: number;
  results?: Record<string, TmdbWatchProviderRegion>;
}

// Recommendations — movie-recommendations is Record<string, never> in schema,
// so we base on tv-series-recommendations and add movie fields TMDB returns.
type TvRecResult = NonNullable<OpResponse<"tv-series-recommendations">["results"]>[number];
export type TmdbRecommendationResponse = Omit<
  OpResponse<"tv-series-recommendations">,
  "results"
> & {
  results?: (TvRecResult & {
    title?: string;
    original_title?: string;
    release_date?: string;
  })[];
};

// Find — schema types tv_results and tv_episode_results as unknown[]
export type TmdbFindResult = Omit<OpResponse<"find-by-id">, "tv_results" | "tv_episode_results"> & {
  tv_results?: TmdbSearchResult[];
  tv_episode_results?: {
    id: number;
    episode_number: number;
    name: string;
    season_number: number;
    show_id: number;
  }[];
};

// Videos
export type TmdbVideo = NonNullable<OpResponse<"movie-videos">["results"]>[number];

// Genres
export type TmdbGenre = NonNullable<OpResponse<"genre-movie-list">["genres"]>[number];

// Person — schema types deathday as unknown
export type TmdbPersonDetails = Omit<OpResponse<"person-details">, "deathday"> & {
  deathday?: string | null;
};

// ─── Client setup ───────────────────────────────────────────────────

function getApiKey() {
  const key = process.env.TMDB_API_READ_ACCESS_TOKEN;
  if (!key) throw new Error("TMDB_API_READ_ACCESS_TOKEN is not set");
  return key;
}

// Schema paths start with /3/…. resolveTmdbBase decides whether the configured
// base already carries /3 (keep paths as-is) or is a proxy mounted at the API
// root (strip /3 from each request path). See ./config.
const TMDB_VERSION_PREFIX_RE = /^\/3\//;
const { baseUrl, stripVersionPrefix } = resolveTmdbBase(process.env.TMDB_API_BASE_URL);

const baseUrlRewriteMiddleware: Middleware | null = stripVersionPrefix
  ? {
      async onRequest({ request }) {
        // Custom proxy: strip the /3 prefix from schema paths so requests
        // go to e.g. https://tmdb.internal/search/multi instead of /3/search/multi
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(TMDB_VERSION_PREFIX_RE, "/");
        return new Request(url.toString(), request);
      },
    }
  : null;

// ─── Metadata language ──────────────────────────────────────────────

export const METADATA_LANGUAGES = ["en-US", "es-ES", "es-MX"] as const;
export type MetadataLanguage = (typeof METADATA_LANGUAGES)[number];

/** Where to look when a translation is missing, after the chosen language. */
const LANGUAGE_FALLBACKS: Record<MetadataLanguage, string[]> = {
  "en-US": [],
  "es-ES": ["es-MX", "en-US"],
  "es-MX": ["es-ES", "en-US"],
};

let metadataLanguage: MetadataLanguage = "en-US";

/** Language TMDB text (titles, overviews, episode names) is requested in. */
export function setTmdbLanguage(language: MetadataLanguage) {
  metadataLanguage = language;
}

export function getTmdbLanguage(): MetadataLanguage {
  return metadataLanguage;
}

/** Add `language` to every request that doesn't set its own (TMDB defaults to en-US). */
const languageMiddleware: Middleware = {
  async onRequest({ request }) {
    if (metadataLanguage === "en-US") return request;
    const url = new URL(request.url);
    if (url.searchParams.has("language")) return request;
    url.searchParams.set("language", metadataLanguage);
    return new Request(url.toString(), request);
  },
};

const TMDB_REQUEST_TIMEOUT_MS = 30_000;

const requestTimeouts = new WeakMap<Request, Timer>();

const timeoutMiddleware: Middleware = {
  async onRequest({ request }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TMDB_REQUEST_TIMEOUT_MS);
    const newRequest = new Request(request, { signal: controller.signal });
    requestTimeouts.set(newRequest, timeout);
    return newRequest;
  },
  async onResponse({ request }) {
    const timeout = requestTimeouts.get(request);
    if (timeout) clearTimeout(timeout);
    return undefined;
  },
};

const authMiddleware: Middleware = {
  async onRequest({ request }) {
    request.headers.set("Authorization", `Bearer ${getApiKey()}`);
    request.headers.set("Accept", "application/json");
    return request;
  },
};

const requestTimings = new WeakMap<Request, number>();

const loggingMiddleware: Middleware = {
  async onRequest({ request }) {
    requestTimings.set(request, performance.now());
    return request;
  },
  async onResponse({ request, response }) {
    const start = requestTimings.get(request);
    const elapsed = start ? Math.round(performance.now() - start) : 0;
    if (!response.ok) {
      log.warn(`${request.url} -> ${response.status} ${response.statusText} (${elapsed}ms)`);
    } else {
      log.debug(`${request.url} -> ${response.status} (${elapsed}ms)`);
    }
    return undefined;
  },
};

const client = createClient<paths>({ baseUrl });
if (baseUrlRewriteMiddleware) client.use(baseUrlRewriteMiddleware);
client.use(languageMiddleware, timeoutMiddleware, authMiddleware, loggingMiddleware);

// ─── Translation fallback ───────────────────────────────────────────

interface TmdbTranslations {
  translations?: {
    iso_639_1: string;
    iso_3166_1: string;
    data?: { title?: string; name?: string; overview?: string };
  }[];
}

/** First non-empty value across the chosen language and its fallbacks. */
function pickTranslation(
  translations: TmdbTranslations | undefined,
  field: "title" | "name" | "overview",
): string | undefined {
  const list = translations?.translations ?? [];
  for (const tag of [metadataLanguage, ...LANGUAGE_FALLBACKS[metadataLanguage]]) {
    const [lang, region] = tag.split("-");
    const hit = list.find((t) => t.iso_639_1 === lang && t.iso_3166_1 === region);
    const value = hit?.data?.[field]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * TMDB leaves fields empty (overview) or in the original language (title) when the requested
 * translation is missing; fill them from the closest available translation instead.
 */
export function applyDetailFallback<T extends { overview?: string | null; translations?: unknown }>(
  data: T,
  titleField: "title" | "name",
): T {
  if (metadataLanguage === "en-US") return data;
  const translations = data.translations as TmdbTranslations | undefined;
  const result: Record<string, unknown> = { ...data };
  const title = pickTranslation(translations, titleField);
  if (title) result[titleField] = title;
  if (!data.overview?.trim()) {
    const overview = pickTranslation(translations, "overview");
    if (overview) result.overview = overview;
  }
  return result as T;
}

/** Translated detail requests also fetch all translations for the fallback above. */
function withTranslations(appendToResponse: string) {
  return metadataLanguage === "en-US" ? appendToResponse : `${appendToResponse},translations`;
}

/** Placeholder episode names TMDB uses when no real name exists in a language. */
const GENERIC_EPISODE_NAME_RE = /^(episode|episodio|capítulo|capitulo|ep\.?)\s*\d+$/i;

// ─── Search ─────────────────────────────────────────────────────────

export async function searchMulti(query: string, page = 1) {
  const { data, error } = await client.GET("/3/search/multi", {
    params: { query: { query, page, include_adult: false } },
  });
  if (error) throw new Error("TMDB API error: search/multi");
  return data;
}

export async function searchMovies(query: string, page = 1) {
  const { data, error } = await client.GET("/3/search/movie", {
    params: { query: { query, page } },
  });
  if (error) throw new Error("TMDB API error: search/movie");
  return data;
}

export async function searchTv(query: string, page = 1) {
  const { data, error } = await client.GET("/3/search/tv", {
    params: { query: { query, page } },
  });
  if (error) throw new Error("TMDB API error: search/tv");
  return data;
}

// ─── Details ────────────────────────────────────────────────────────

export async function getMovieDetails(tmdbId: number) {
  const { data, error } = await client.GET("/3/movie/{movie_id}", {
    params: {
      path: { movie_id: tmdbId },
      query: { append_to_response: withTranslations("release_dates") },
    },
  });
  if (error) throw new Error(`TMDB API error: movie/${tmdbId}`);
  return applyDetailFallback(data as TmdbMovieDetails & { translations?: unknown }, "title");
}

export async function getTvDetails(tmdbId: number) {
  const { data, error } = await client.GET("/3/tv/{series_id}", {
    params: {
      path: { series_id: tmdbId },
      query: { append_to_response: withTranslations("content_ratings,external_ids") },
    },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}`);
  return applyDetailFallback(data as TmdbTvDetails & { translations?: unknown }, "name");
}

export interface TmdbEpisodeGroupSummary {
  id: string;
  name: string;
  description?: string;
  /** 1 original air date, 2 absolute, 3 DVD, 4 digital, 5 story arc, 6 production, 7 TV. */
  type: number;
  group_count: number;
  episode_count: number;
}

/** Alternative episode orderings (e.g. seasons as released on streaming or TVDB). */
export async function getTvEpisodeGroups(tmdbId: number) {
  const { data, error } = await client.GET("/3/tv/{series_id}/episode_groups", {
    params: { path: { series_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/episode_groups`);
  return ((data as { results?: TmdbEpisodeGroupSummary[] }).results ?? []).filter(
    (g) => g.id && g.name,
  );
}

export interface TmdbEpisodeGroupDetails {
  id: string;
  name: string;
  groups: {
    name: string;
    order: number;
    episodes: { season_number: number; episode_number: number; order: number }[];
  }[];
}

export async function getEpisodeGroupDetails(groupId: string) {
  const { data, error } = await client.GET("/3/tv/episode_group/{tv_episode_group_id}", {
    params: { path: { tv_episode_group_id: groupId } },
  });
  if (error) throw new Error(`TMDB API error: tv/episode_group/${groupId}`);
  return data as unknown as TmdbEpisodeGroupDetails;
}

export type TmdbCollectionDetails = {
  id: number;
  name: string;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  parts?: {
    id: number;
    title?: string;
    overview?: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
    release_date?: string;
    vote_average?: number;
  }[];
};

/** A movie collection (e.g. a film series) with all of its movies. */
export async function getCollectionDetails(collectionId: number) {
  const { data, error } = await client.GET("/3/collection/{collection_id}", {
    params: { path: { collection_id: collectionId } },
  });
  if (error) throw new Error(`TMDB API error: collection/${collectionId}`);
  return data as unknown as TmdbCollectionDetails;
}

export async function getTvExternalIds(tmdbId: number) {
  const { data, error } = await client.GET("/3/tv/{series_id}/external_ids", {
    params: { path: { series_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/external_ids`);
  return data;
}

async function fetchTvSeason(tmdbId: number, seasonNumber: number, language?: string) {
  const { data, error } = await client.GET("/3/tv/{series_id}/season/{season_number}", {
    params: {
      path: { series_id: tmdbId, season_number: seasonNumber },
      ...(language ? { query: { language } } : {}),
    },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/season/${seasonNumber}`);
  return data;
}

export async function getTvSeasonDetails(tmdbId: number, seasonNumber: number) {
  const data = await fetchTvSeason(tmdbId, seasonNumber);
  if (metadataLanguage === "en-US" || !data) return data;

  // Fill missing/placeholder episode names and overviews from the fallback languages.
  const needsName = (name?: string | null) => !name?.trim() || GENERIC_EPISODE_NAME_RE.test(name);
  const missing = () =>
    (data.episodes ?? []).some((ep) => needsName(ep.name) || !ep.overview?.trim()) ||
    !data.overview?.trim();

  for (const language of LANGUAGE_FALLBACKS[metadataLanguage]) {
    if (!missing()) break;
    let fallback: Awaited<ReturnType<typeof fetchTvSeason>>;
    try {
      fallback = await fetchTvSeason(tmdbId, seasonNumber, language);
    } catch {
      continue;
    }
    const byNumber = new Map(
      (fallback?.episodes ?? []).map((ep) => [ep.episode_number, ep] as const),
    );
    for (const ep of data.episodes ?? []) {
      const other = byNumber.get(ep.episode_number);
      if (!other) continue;
      if (needsName(ep.name) && other.name?.trim() && !needsName(other.name)) ep.name = other.name;
      if (!ep.overview?.trim() && other.overview?.trim()) ep.overview = other.overview;
    }
    if (!data.overview?.trim() && fallback?.overview?.trim()) data.overview = fallback.overview;
  }
  return data;
}

// ─── Watch Providers ────────────────────────────────────────────────

export async function getWatchProviders(tmdbId: number, type: "movie" | "tv") {
  if (type === "movie") {
    const { data, error } = await client.GET("/3/movie/{movie_id}/watch/providers", {
      params: { path: { movie_id: tmdbId } },
    });
    if (error) throw new Error(`TMDB API error: movie/${tmdbId}/watch/providers`);
    return data as TmdbWatchProviderResponse;
  }
  const { data, error } = await client.GET("/3/tv/{series_id}/watch/providers", {
    params: { path: { series_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/watch/providers`);
  return data as TmdbWatchProviderResponse;
}

export interface TmdbWatchProviderListItem {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  display_priorities: Record<string, number>;
}

export async function getWatchProviderList(type: "movie" | "tv", watchRegion?: string) {
  const query = watchRegion ? ({ watch_region: watchRegion } as Record<string, unknown>) : {};
  if (type === "movie") {
    const { data, error } = await client.GET("/3/watch/providers/movie", {
      params: { query },
    });
    if (error) throw new Error("TMDB API error: watch/providers/movie");
    return (data as { results?: TmdbWatchProviderListItem[] }).results ?? [];
  }
  const { data, error } = await client.GET("/3/watch/providers/tv", {
    params: { query },
  });
  if (error) throw new Error("TMDB API error: watch/providers/tv");
  return (data as { results?: TmdbWatchProviderListItem[] }).results ?? [];
}

// ─── Recommendations & Similar ──────────────────────────────────────

export async function getRecommendations(tmdbId: number, type: "movie" | "tv") {
  if (type === "movie") {
    const { data, error } = await client.GET("/3/movie/{movie_id}/recommendations", {
      params: { path: { movie_id: tmdbId } },
    });
    if (error) throw new Error(`TMDB API error: movie/${tmdbId}/recommendations`);
    return data as TmdbRecommendationResponse;
  }
  const { data, error } = await client.GET("/3/tv/{series_id}/recommendations", {
    params: { path: { series_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/recommendations`);
  return data as TmdbRecommendationResponse;
}

export async function getSimilar(tmdbId: number, type: "movie" | "tv") {
  if (type === "movie") {
    const { data, error } = await client.GET("/3/movie/{movie_id}/similar", {
      params: { path: { movie_id: tmdbId } },
    });
    if (error) throw new Error(`TMDB API error: movie/${tmdbId}/similar`);
    return data as TmdbRecommendationResponse;
  }
  // Schema incorrectly types series_id as string here (number everywhere else)
  const { data, error } = await client.GET("/3/tv/{series_id}/similar", {
    params: { path: { series_id: String(tmdbId) } },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/similar`);
  return data as TmdbRecommendationResponse;
}

// ─── Trending & Popular ─────────────────────────────────────────────

export async function getTrending(
  mediaType: "all" | "movie" | "tv",
  timeWindow: "day" | "week" = "day",
  page = 1,
) {
  // TMDB trending supports `page` but the generated schema omits it, so widen the query type.
  const query = { page } as Record<string, unknown>;

  if (mediaType === "movie") {
    const { data, error } = await client.GET("/3/trending/movie/{time_window}", {
      params: { path: { time_window: timeWindow }, query },
    });
    if (error) throw new Error("TMDB API error: trending/movie");
    return data;
  }
  if (mediaType === "tv") {
    const { data, error } = await client.GET("/3/trending/tv/{time_window}", {
      params: { path: { time_window: timeWindow }, query },
    });
    if (error) throw new Error("TMDB API error: trending/tv");
    return data;
  }
  const { data, error } = await client.GET("/3/trending/all/{time_window}", {
    params: { path: { time_window: timeWindow }, query },
  });
  if (error) throw new Error("TMDB API error: trending/all");
  return data;
}

export async function getPopular(type: "movie" | "tv", page = 1) {
  if (type === "movie") {
    const { data, error } = await client.GET("/3/movie/popular", {
      params: { query: { page } },
    });
    if (error) throw new Error("TMDB API error: movie/popular");
    return data;
  }
  const { data, error } = await client.GET("/3/tv/popular", {
    params: { query: { page } },
  });
  if (error) throw new Error("TMDB API error: tv/popular");
  return data;
}

// ─── Genres ─────────────────────────────────────────────────────────

export async function getGenres(type: "movie" | "tv") {
  if (type === "movie") {
    const { data, error } = await client.GET("/3/genre/movie/list", {});
    if (error) throw new Error("TMDB API error: genre/movie/list");
    return data;
  }
  const { data, error } = await client.GET("/3/genre/tv/list", {});
  if (error) throw new Error("TMDB API error: genre/tv/list");
  return data;
}

// ─── Discover ───────────────────────────────────────────────────────

export async function discover(type: "movie" | "tv", params: Record<string, string>, page = 1) {
  // Discover accepts many dynamic filter params (with_genres, vote_count.gte, etc.)
  // that aren't individually typed in the schema, so widen to Record<string, unknown>.
  if (type === "movie") {
    const { data, error } = await client.GET("/3/discover/movie", {
      params: { query: { ...params, page } as Record<string, unknown> },
    });
    if (error) throw new Error("TMDB API error: discover/movie");
    return data;
  }
  const { data, error } = await client.GET("/3/discover/tv", {
    params: { query: { ...params, page } as Record<string, unknown> },
  });
  if (error) throw new Error("TMDB API error: discover/tv");
  return data;
}

// ─── Videos ─────────────────────────────────────────────────────────

export async function getVideos(tmdbId: number, type: "movie" | "tv") {
  if (type === "movie") {
    const { data, error } = await client.GET("/3/movie/{movie_id}/videos", {
      params: { path: { movie_id: tmdbId } },
    });
    if (error) throw new Error(`TMDB API error: movie/${tmdbId}/videos`);
    return data;
  }
  const { data, error } = await client.GET("/3/tv/{series_id}/videos", {
    params: { path: { series_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/videos`);
  return data;
}

// ─── Find by External ID ───────────────────────────────────────────

export async function findByExternalId(externalId: string, source: "imdb_id" | "tvdb_id") {
  const { data, error } = await client.GET("/3/find/{external_id}", {
    params: {
      path: { external_id: externalId },
      query: { external_source: source },
    },
  });
  if (error) throw new Error(`TMDB API error: find/${externalId}`);
  return data as TmdbFindResult;
}

// ─── Person / Credits ───────────────────────────────────────────────

export async function getMovieCredits(tmdbId: number) {
  const { data, error } = await client.GET("/3/movie/{movie_id}/credits", {
    params: { path: { movie_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: movie/${tmdbId}/credits`);
  return data;
}

export async function getTvAggregateCredits(tmdbId: number) {
  const { data, error } = await client.GET("/3/tv/{series_id}/aggregate_credits", {
    params: { path: { series_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: tv/${tmdbId}/aggregate_credits`);
  return data;
}

export async function getPersonDetails(tmdbId: number) {
  const { data, error } = await client.GET("/3/person/{person_id}", {
    params: { path: { person_id: tmdbId } },
  });
  if (error) throw new Error(`TMDB API error: person/${tmdbId}`);
  return data as TmdbPersonDetails;
}

export async function getPersonCombinedCredits(tmdbId: number) {
  const { data, error } = await client.GET(
    "/3/person/{person_id}/combined_credits",
    // Schema incorrectly types person_id as string here (number everywhere else)
    { params: { path: { person_id: String(tmdbId) } } },
  );
  if (error) throw new Error(`TMDB API error: person/${tmdbId}/combined_credits`);
  return data;
}

export async function searchPerson(query: string, page = 1) {
  const { data, error } = await client.GET("/3/search/person", {
    params: { query: { query, page } },
  });
  if (error) throw new Error("TMDB API error: search/person");
  return data;
}

export { tmdbImageUrl } from "./image";
