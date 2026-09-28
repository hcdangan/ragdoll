import { cookies, headers } from "next/headers";

import { bufferOf, createSessionId } from "./crypto";
import { getServerEnv } from "./env";
import { SESSION_COOKIE_DEV, SESSION_COOKIE_PROD, SESSION_HEADER } from "./session-constants";

/**
 * Session identity and transport.
 *
 * Deliberately free of `server-only` and of Node builtins so middleware can verify
 * a cookie without pulling request-scoped state into its bundle. Web Crypto only,
 * because middleware runs in the Edge runtime by default.
 *
 * The cookie carries a **session id, not session state**. An earlier design sealed
 * the whole session — including uploaded PDF bytes — into the cookie, which cannot
 * work: the 6 MB session limit becomes ~8 MB of base64 against a ~4 KB cookie
 * budget, so the browser silently ended up with no session at all and everything
 * degraded to whichever Function instance held the memory. The id is signed, so it
 * cannot be forged, and the state lives server-side where AGENTS.md puts it.
 */

const encoder = new TextEncoder();

/** Session lifetime in seconds; the sliding window matches the session store. */
const SESSION_TTL_SECONDS = 15 * 60;

/** Encodes to a view backed by a plain ArrayBuffer, as Web Crypto requires. */
const encode = (value: string): Uint8Array<ArrayBuffer> => bufferOf(encoder.encode(value));

/** Purpose-scoped key material, so the id signature cannot be replayed elsewhere. */
const keyBytes = async (secret: string, purpose: string): Promise<Uint8Array<ArrayBuffer>> =>
  bufferOf(new Uint8Array(await crypto.subtle.digest("SHA-256", encode(`${purpose}:${secret}`))));

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Signs a session id for the cookie: `"<id>.<hmac>"`.
 * @param secret Master secret.
 * @param id Session identifier.
 */
export const signId = async (secret: string, id: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    await keyBytes(secret, "session-id"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encode(id)));
  return `${id}.${toBase64Url(signature)}`;
};

/**
 * Verifies a signed session id.
 * @param secret Master secret.
 * @param token Cookie value.
 * @returns The id, or null when the token is malformed, forged or has no session.
 */
export const verifyId = async (secret: string, token: string): Promise<string | null> => {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }
  const id = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = await signId(secret, id);
  return expected.slice(separator + 1) === signature ? id : null;
};

/** The secret that signs session ids, or an empty string when none is configured. */
export const sessionSecret = (): string => getServerEnv().sessionSecret;

export const sessionCookieName = (): string =>
  getServerEnv().nodeEnv === "production" ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;

/** Cookie attributes shared by middleware and the session store. */
export const sessionCookieOptions = (): {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: "/";
  readonly maxAge: number;
} => ({
  httpOnly: true,
  sameSite: "lax",
  secure: getServerEnv().nodeEnv === "production",
  path: "/",
  // Mirrors LIMITS.sessionTtlMs; duplicated here so this module stays free of the
  // rules module, which is also imported by client components.
  maxAge: SESSION_TTL_SECONDS,
});

/**
 * Reads the signed session token for the current request.
 *
 * Middleware always stamps the token onto a request header, so this is the primary
 * path; the cookie jar is only consulted by route handlers, which may receive
 * requests that did not pass through the matcher.
 */
export const readSessionToken = async (): Promise<string | null> => {
  const headerStore = await headers();
  const fromHeader = headerStore.get(SESSION_HEADER);
  if (fromHeader !== null && fromHeader.length > 0) {
    return fromHeader;
  }
  const cookieStore = await cookies();
  return cookieStore.get(sessionCookieName())?.value ?? null;
};

/** Mints a fresh session id, for middleware and for provisioning. */
export const newSessionId = (): string => createSessionId();
