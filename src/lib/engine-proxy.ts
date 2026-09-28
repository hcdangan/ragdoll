import { NextResponse, type NextRequest } from "next/server";

/**
 * Local stand-in for the `/engine` rewrite declared in `vercel.json`.
 *
 * Vercel routes `/engine/*` to the Python function before Next.js sees the request.
 * `next dev` and `next start` have no Vercel router, so without this the
 * same-origin engine default — the thing that makes an imported deployment work with
 * no configuration — could not be exercised locally at all.
 *
 * `vercel.json` stays the source of truth for production; this keeps the two in
 * step for development, the Playwright suite and the HTTP smoke test.
 */

const ENGINE_ORIGIN = process.env.RAGDOLL_LOCAL_ENGINE_URL ?? "http://127.0.0.1:8000";
export const ENGINE_PREFIX = "/engine";

/** True when this request should be proxied to the engine under test. */
export const isEngineProxyRequest = (pathname: string): boolean =>
  pathname === ENGINE_PREFIX || pathname.startsWith(`${ENGINE_PREFIX}/`);

/**
 * Headers that describe *this* hop rather than the message, and that break the
 * upstream request if forwarded.
 *
 * `content-length` is the important one: the body is re-read from the incoming
 * request, so the original length no longer matches and the runtime rejects the
 * fetch outright with "TypeError: fetch failed" — which surfaces as an opaque 502.
 * `host` would address the wrong server, and the hop-by-hop headers must not travel.
 */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "content-length",
  "host",
] as const;

/** Builds the header set for the upstream request. */
const upstreamHeaders = (request: NextRequest): Headers => {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) {
    headers.delete(name);
  }
  return headers;
};

/**
 * Forwards a request to the local engine, streaming the response straight back.
 * @param request Incoming request for `/engine/*`.
 */
export const proxyToLocalEngine = async (request: NextRequest): Promise<NextResponse> => {
  const path = request.nextUrl.pathname.slice(ENGINE_PREFIX.length) || "/";
  const target = new URL(`${path}${request.nextUrl.search}`, ENGINE_ORIGIN);

  try {
    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    const upstream = await fetch(target, {
      method,
      headers: upstreamHeaders(request),
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
      // Forwarding the client's signal keeps an interrupted answer from leaving the
      // provider call running upstream.
      signal: request.signal,
      redirect: "manual",
    });

    const responseHeaders = new Headers(upstream.headers);
    // Body encoding no longer matches after the hop, so let the runtime re-derive it.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
    return new NextResponse(
      `Local engine proxy could not reach ${ENGINE_ORIGIN}: ${String(cause)}`,
      { status: 502, headers: { "Content-Type": "text/plain" } },
    );
  }
};
