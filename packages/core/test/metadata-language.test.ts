import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { titles } from "@sofa/db/schema";
import { clearAllTables, eq, insertTitle, testDb } from "@sofa/test/db";
import { applyDetailFallback, getTmdbLanguage, setTmdbLanguage } from "@sofa/tmdb/client";

import {
  changeMetadataLanguage,
  getMetadataLanguage,
  getMetadataLanguageChangedAt,
} from "../src/metadata-language";

beforeEach(() => {
  clearAllTables();
  setTmdbLanguage("en-US");
});

afterEach(() => {
  setTmdbLanguage("en-US");
});

describe("changeMetadataLanguage", () => {
  test("defaults to English", () => {
    expect(getMetadataLanguage()).toBe("en-US");
    expect(getMetadataLanguageChangedAt()).toBeNull();
  });

  test("saves the language, applies it and marks fetched titles stale", () => {
    insertTitle({ id: "t1" });
    insertTitle({ id: "t2", tmdbId: 2 });
    const fetchedAt = new Date("2026-01-01T00:00:00Z");
    testDb.update(titles).set({ lastFetchedAt: fetchedAt }).where(eq(titles.id, "t1")).run();

    expect(changeMetadataLanguage("es-MX")).toBe(true);
    expect(getMetadataLanguage()).toBe("es-MX");
    expect(getTmdbLanguage()).toBe("es-MX");
    expect(getMetadataLanguageChangedAt()).toBeInstanceOf(Date);

    const t1 = testDb.select().from(titles).where(eq(titles.id, "t1")).get();
    const t2 = testDb.select().from(titles).where(eq(titles.id, "t2")).get();
    expect(t1?.lastFetchedAt?.getTime()).toBeLessThan(fetchedAt.getTime());
    // Never-fetched titles stay unfetched
    expect(t2?.lastFetchedAt).toBeNull();
  });

  test("returns false when nothing changes", () => {
    changeMetadataLanguage("es-ES");
    expect(changeMetadataLanguage("es-ES")).toBe(false);
  });
});

describe("applyDetailFallback", () => {
  const translations = {
    translations: [
      { iso_639_1: "es", iso_3166_1: "ES", data: { name: "Serie (España)", overview: "" } },
      { iso_639_1: "es", iso_3166_1: "MX", data: { name: "", overview: "Sinopsis latina" } },
      { iso_639_1: "en", iso_3166_1: "US", data: { name: "Show", overview: "English overview" } },
    ],
  };

  test("leaves English untouched", () => {
    const data = { name: "原題", overview: "", translations };
    expect(applyDetailFallback(data, "name")).toEqual(data);
  });

  test("fills missing fields from the closest language", () => {
    setTmdbLanguage("es-MX");
    const result = applyDetailFallback({ name: "原題", overview: "", translations }, "name");
    // No Latin American title → Spain's; overview comes from es-MX itself
    expect(result.name).toBe("Serie (España)");
    expect(result.overview).toBe("Sinopsis latina");
  });

  test("keeps an overview TMDB already returned", () => {
    setTmdbLanguage("es-ES");
    const result = applyDetailFallback({ name: "x", overview: "Ya traducido", translations }, "name");
    expect(result.overview).toBe("Ya traducido");
  });
});
