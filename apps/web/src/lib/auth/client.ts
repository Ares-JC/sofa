import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [adminClient()],
  // Never wait forever on the auth server (see loadSession below).
  fetchOptions: { timeout: 15_000 },
});

export const { signIn, signUp, useSession } = authClient;

type Session = NonNullable<Awaited<ReturnType<typeof authClient.getSession>>["data"]>;

/** Last session the server confirmed, reused when a later check fails for a transient reason. */
let lastKnownSession: Session | null = null;

/** Sign out and forget the cached session, so a later failed check can't bring it back. */
export const signOut = ((...args: Parameters<typeof authClient.signOut>) => {
  lastKnownSession = null;
  return authClient.signOut(...args);
}) as typeof authClient.signOut;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The current session for route guards. Only a definite "signed out" answer returns null: a
 * timeout, rate limit (429), server hiccup or dropped connection is retried, then falls back to
 * the last confirmed session instead of bouncing the user to the login page.
 */
export async function loadSession(): Promise<Session | null> {
  // Route guards run on every page change. Reuse a recently confirmed session right away and
  // re-check it in the background, instead of making every tap wait for a round trip.
  if (lastKnownSession && Date.now() - lastCheckedAt < SESSION_REUSE_MS) {
    if (!backgroundCheck) {
      backgroundCheck = fetchSession()
        .catch(() => undefined)
        .finally(() => {
          backgroundCheck = null;
        });
    }
    return lastKnownSession;
  }
  return fetchSession();
}

/** How long a confirmed session is reused by route guards before waiting for a fresh check. */
const SESSION_REUSE_MS = 5 * 60_000;
let lastCheckedAt = 0;
let backgroundCheck: Promise<unknown> | null = null;

async function fetchSession(): Promise<Session | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let error: { status?: number } | null = null;
    try {
      const result = await authClient.getSession();
      if (result.data) {
        lastKnownSession = result.data;
        lastCheckedAt = Date.now();
        return result.data;
      }
      if (!result.error) {
        lastKnownSession = null;
        return null;
      }
      error = result.error;
    } catch {
      error = {};
    }
    if (error.status === 401 || error.status === 403) {
      lastKnownSession = null;
      return null;
    }
    if (attempt < 2) await sleep(400 * 3 ** attempt);
  }
  if (lastKnownSession) return lastKnownSession;
  throw new Error("Couldn't reach the server to check your session. Please try again.");
}
