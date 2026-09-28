/**
 * Cookie and header names shared by middleware, route handlers and the client.
 * This module is a leaf — no imports — so middleware never drags server code
 * into its bundle.
 */

export const SESSION_COOKIE_PROD = "__Host-ragdoll-sid";
export const SESSION_COOKIE_DEV = "ragdoll-sid";

/** Sealed session cookie value, forwarded from the browser to route handlers. */
export const SESSION_HEADER = "x-ragdoll-session";

/** Set to "1" when middleware minted a brand-new session for this request. */
export const SESSION_NEW_HEADER = "x-ragdoll-session-new";
