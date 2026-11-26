import { Hono } from "hono";

import { findIntegrationByToken } from "@sofa/core/integrations";
import type { PlaybackProgressEvent, WebhookEvent } from "@sofa/core/webhooks";
import {
  parseEmbyPayload,
  parseEmbyProgress,
  parseJellyfinPayload,
  parseJellyfinProgress,
  parsePlexPayload,
  parsePlexProgress,
  processPlaybackProgress,
  processWebhook,
} from "@sofa/core/webhooks";
import { createLogger } from "@sofa/logger";

const log = createLogger("webhooks");

const app = new Hono();

app.post("/:token", async (c) => {
  const token = c.req.param("token");

  // Look up connection by token — this IS the auth
  const connection = findIntegrationByToken(token);

  if (!connection || !connection.enabled) {
    // Always return 200 to avoid retry storms from media servers
    return c.json({ ok: true });
  }

  // Only webhook-type integrations are handled here
  if (connection.type !== "webhook") {
    return c.json({ ok: true });
  }

  const provider = connection.provider as "plex" | "jellyfin" | "emby";

  try {
    let event: WebhookEvent | null;
    let progress: PlaybackProgressEvent | null = null;
    if (provider === "plex") {
      const formData = (await c.req.raw.formData()) as unknown as FormData;
      event = parsePlexPayload(formData);
      if (!event) progress = parsePlexProgress(formData);
    } else if (provider === "emby") {
      const body = await c.req.json();
      event = parseEmbyPayload(body);
      if (!event) progress = parseEmbyProgress(body);
    } else {
      const body = await c.req.json();
      event = parseJellyfinPayload(body);
      if (!event) progress = parseJellyfinProgress(body);
    }

    const filter = {
      allowedAccounts: connection.allowedAccounts,
      serverUsername: connection.serverUsername,
    };

    if (event) {
      await processWebhook(connection.id, connection.userId, provider, event, filter);
    } else if (progress) {
      await processPlaybackProgress(connection.userId, provider, progress, filter);
    }
    // Anything else isn't a relevant event type — silently ignore.
  } catch (err) {
    // Swallow errors — never return non-200 to media servers
    log.warn("Webhook processing failed:", err);
  }

  return c.json({ ok: true });
});

export default app;
