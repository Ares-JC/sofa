import {
  deleteIntegrationByUserAndProvider,
  getIntegrationByToken,
  getIntegrationByUserAndProvider,
  getRecentEventsForIntegrations,
  getSeenAccountsForIntegration,
  getUserIntegrations,
  insertIntegration,
  regenerateIntegrationToken,
  updateIntegrationSettings,
} from "@sofa/db/queries/integrations";

const LIST_PROVIDERS = new Set(["sonarr", "radarr"]);

function integrationTypeFor(provider: string): "webhook" | "list" {
  return LIST_PROVIDERS.has(provider) ? "list" : "webhook";
}

function generateToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

function serializeIntegration(row: {
  id: string;
  provider: string;
  type: "webhook" | "list";
  token: string;
  enabled: boolean;
  lastEventAt: Date | null;
  createdAt: Date;
  serverUsername: string | null;
  allowedAccounts: { id: string; name: string }[] | null;
}) {
  return {
    ...row,
    serverUsername: row.serverUsername ?? null,
    allowedAccounts: normalizeAllowedAccounts(row.allowedAccounts),
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function listUserIntegrations(userId: string) {
  const userIntegrations = getUserIntegrations(userId);

  const integrationIds = userIntegrations.map((i) => i.id);
  const eventsByIntegration = getRecentEventsForIntegrations(integrationIds);

  const result = userIntegrations.map((integration) => {
    const events = eventsByIntegration.get(integration.id) ?? [];
    const seenAccounts =
      integration.type === "webhook"
        ? getSeenAccountsForIntegration(integration.id).flatMap((a) =>
            a.id ? [{ id: a.id, name: a.name ?? a.id, lastSeenAt: toIso(a.lastSeenAt) }] : [],
          )
        : [];
    return Object.assign(serializeIntegration(integration), {
      recentEvents: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        mediaType: e.mediaType,
        mediaTitle: e.mediaTitle,
        status: e.status,
        errorMessage: e.errorMessage ?? null,
        accountName: e.accountName ?? null,
        receivedAt: e.receivedAt.toISOString(),
      })),
      seenAccounts,
    });
  });

  return { integrations: result };
}

function toIso(value: Date | string | number | null | undefined): string | null {
  if (value == null) return null;
  const date =
    value instanceof Date ? value : new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Drop blank/duplicate entries; an empty list means "no filter" (null). */
export function normalizeAllowedAccounts(
  accounts: { id: string; name: string }[] | null | undefined,
): { id: string; name: string }[] | null {
  if (!accounts) return null;
  const seen = new Set<string>();
  const result: { id: string; name: string }[] = [];
  for (const account of accounts) {
    const id = account.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: account.name?.trim() || id });
  }
  return result.length > 0 ? result : null;
}

/** Trim a media server username; blank means "no filter". */
export function normalizeServerUsername(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createOrUpdateIntegration(
  userId: string,
  provider: string,
  enabled?: boolean,
  serverUsername?: string | null,
  allowedAccounts?: { id: string; name: string }[] | null,
) {
  const existing = getIntegrationByUserAndProvider(userId, provider);
  // The user/account filter only applies to webhook (media server) integrations.
  const acceptsUsername = integrationTypeFor(provider) === "webhook";

  if (existing) {
    const changes: {
      enabled?: boolean;
      serverUsername?: string | null;
      allowedAccounts?: { id: string; name: string }[] | null;
    } = {};
    if (enabled !== undefined) changes.enabled = enabled;
    if (serverUsername !== undefined && acceptsUsername) {
      changes.serverUsername = normalizeServerUsername(serverUsername);
    }
    if (allowedAccounts !== undefined && acceptsUsername) {
      changes.allowedAccounts = normalizeAllowedAccounts(allowedAccounts);
      // Picking accounts replaces the legacy name filter.
      changes.serverUsername = null;
    }
    if (Object.keys(changes).length > 0) {
      const row = updateIntegrationSettings(existing.id, changes);
      return serializeIntegration(row);
    }
    return serializeIntegration(existing);
  }

  const row = insertIntegration({
    userId,
    provider,
    type: integrationTypeFor(provider),
    token: generateToken(),
    enabled: enabled ?? true,
    serverUsername: acceptsUsername ? normalizeServerUsername(serverUsername) : null,
    allowedAccounts: acceptsUsername ? normalizeAllowedAccounts(allowedAccounts) : null,
    createdAt: new Date(),
  });

  return serializeIntegration(row);
}

export function deleteIntegration(userId: string, provider: string): void {
  deleteIntegrationByUserAndProvider(userId, provider);
}

export function regenerateToken(userId: string, provider: string) {
  return regenerateIntegrationToken(userId, provider, generateToken());
}

export function findIntegrationByToken(token: string) {
  return getIntegrationByToken(token);
}

export { serializeIntegration };
