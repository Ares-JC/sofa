import { markAllTitlesStale } from "@sofa/db/queries/metadata";
import { createLogger } from "@sofa/logger";
import {
  METADATA_LANGUAGES,
  type MetadataLanguage,
  getTmdbLanguage,
  setTmdbLanguage,
} from "@sofa/tmdb/client";

import { getSetting, setSetting } from "./settings";

const log = createLogger("metadata-language");

const LANGUAGE_KEY = "metadataLanguage";
const CHANGED_AT_KEY = "metadataLanguageChangedAt";

export { METADATA_LANGUAGES, type MetadataLanguage };

function isMetadataLanguage(value: string | null): value is MetadataLanguage {
  return value != null && (METADATA_LANGUAGES as readonly string[]).includes(value);
}

/** The language titles, overviews and episode names are fetched in (server-wide). */
export function getMetadataLanguage(): MetadataLanguage {
  const stored = getSetting(LANGUAGE_KEY);
  return isMetadataLanguage(stored) ? stored : "en-US";
}

/** When the language last changed; titles fetched before then are refreshed in full. */
export function getMetadataLanguageChangedAt(): Date | null {
  const stored = getSetting(CHANGED_AT_KEY);
  const date = stored ? new Date(stored) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Apply the saved language to the TMDB client (call at startup). */
export function applyMetadataLanguage() {
  setTmdbLanguage(getMetadataLanguage());
}

/**
 * Switch the metadata language. Every fetched title is marked stale so the library refresh (and
 * the next visit to a title) re-downloads it, including all of a show's seasons. Returns whether
 * anything changed.
 */
export function changeMetadataLanguage(language: MetadataLanguage): boolean {
  if (language === getMetadataLanguage() && language === getTmdbLanguage()) return false;
  setSetting(LANGUAGE_KEY, language);
  setSetting(CHANGED_AT_KEY, new Date().toISOString());
  setTmdbLanguage(language);
  markAllTitlesStale();
  log.info(`Metadata language set to ${language}; titles will be refreshed`);
  return true;
}
