import "server-only";

import { headers } from "next/headers";

/**
 * The origin the current request arrived on.
 *
 * Needed because the engine's default location is a same-origin path (`/engine`),
 * and a relative URL cannot be handed to `fetch` — it fails with "Failed to parse
 * URL". `VERCEL_URL` is deliberately *not* used: it is not exposed to the running
 * function, which was verified rather than assumed.
 *
 * Both proxies in front of a deployment rewrite these headers, and Node normalises
 * the port away from `host` (the Host header arrives as `example.com` even when the
 * socket is `:3200`), so the internal port is re-appended for local development.
 */
export const requestOrigin = async (): Promise<string> => {
  const store = await headers();
  const forwardedHost = store.get("x-forwarded-host");
  const host = (forwardedHost ?? store.get("host") ?? "").split(",")[0]?.trim() ?? "";
  const protocol = (store.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() ?? "";

  if (host.length === 0) {
    return "";
  }
  const scheme = protocol.length > 0 ? protocol : host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${withInternalPort(host)}`;
};

const INTERNAL_PORT = process.env.PORT ?? "";

/**
 * Re-appends the listening port for hosts that Node reported without one.
 *
 * Only applies to loopback: a public host genuinely has no port, and adding one
 * would produce a URL nothing answers on.
 */
const withInternalPort = (host: string): string => {
  if (host.includes(":") || INTERNAL_PORT.length === 0) {
    return host;
  }
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  return isLoopback ? `${host}:${INTERNAL_PORT}` : host;
};
