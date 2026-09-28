import { NextResponse, type NextRequest } from "next/server";

import { isEngineProxyRequest, proxyToLocalEngine } from "@/lib/engine-proxy";
import { LIMITS } from "@/lib/rules";
import {
  SESSION_COOKIE_DEV,
  SESSION_COOKIE_PROD,
  SESSION_HEADER,
  SESSION_NEW_HEADER,
} from "@/lib/session-constants";
import { newSessionId, sessionSecret, signId, verifyId } from "@/lib/session-token";

/**
 * Middleware owns two jobs, both of which must happen before a request reaches a
 * route or a Server Action:
 *
 *  1. `/engine/*` is proxied to the local engine. In production Vercel's router does
 *     this from the `vercel.json` rewrite, so the branch is inert there; locally it
 *     is what makes the same-origin engine default testable.
 *  2. Every other request is guaranteed a valid, signed session handle. Server
 *     Actions cannot set cookies, so the handle has to be minted here — and because
 *     middleware also runs for a Server Action POST to the same URL as the page, both
 *     the page and the action see the same handle.
 *
 * The handle is a *session id*, not session state: the cookie is a few dozen bytes
 * regardless of how much the session holds, and the state lives server-side, so an
 * expired or unknown id is cheap to replace.
 *
 * The secret is read from `process.env` rather than through the env module so this
 * file's dependency graph stays limited to Web Crypto.
 */

export const config = {
  matcher: ["/((?!_next/static|_next/image|brand|favicon.ico).*)"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (isEngineProxyRequest(request.nextUrl.pathname)) {
    return proxyToLocalEngine(request);
  }
  return sessionMiddleware(request);
}

async function sessionMiddleware(request: NextRequest): Promise<NextResponse> {
  const isProduction = process.env.NODE_ENV === "production";
  const cookieName = isProduction ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
  const secret = sessionSecret();
  const canMint = secret.length >= 32;

  const requestHeaders = new Headers(request.headers);
  const existing = request.cookies.get(cookieName)?.value ?? null;

  if (existing !== null && existing.length > 0 && (await verifyId(secret, existing)) !== null) {
    requestHeaders.set(SESSION_HEADER, existing);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (!canMint) {
    // Without a signing secret the app runs cookie-less: sessions then live only in
    // process memory, which is correct for a single self-hosted instance.
    return NextResponse.next();
  }

  const token = await signId(secret, newSessionId());
  requestHeaders.set(SESSION_HEADER, token);
  requestHeaders.set(SESSION_NEW_HEADER, "1");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: Math.floor(LIMITS.sessionTtlMs / 1000),
  });

  return response;
}
