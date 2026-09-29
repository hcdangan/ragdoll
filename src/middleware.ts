import { NextResponse, type NextRequest } from "next/server";

import { LIMITS } from "@/lib/rules";
import {
  SESSION_COOKIE_DEV,
  SESSION_COOKIE_PROD,
  SESSION_HEADER,
  SESSION_NEW_HEADER,
} from "@/lib/session-constants";
import { newSessionId, sessionSecret, signId, verifyId } from "@/lib/session-token";

/**
 * Middleware guarantees every request carries a valid, signed session handle
 * before it reaches a route or a Server Action.
 *
 * The handle is a *session id*, not session state: the cookie is a few dozen bytes
 * regardless of how much the session holds, and the state lives server-side, so an
 * expired or unknown id is cheap to replace. Server Actions cannot set cookies, so
 * the handle has to be minted here — and because middleware also runs for a Server
 * Action POST to the same URL as the page, both the page and the action see the
 * same handle.
 *
 * There is no engine branch any more: the RAG pipeline is a module in this same
 * process, so there is nothing to proxy and no internal service URL to rewrite.
 *
 * The secret is read from `process.env` rather than through the env module so this
 * file's dependency graph stays limited to Web Crypto.
 */

export const config = {
  // Node, not Edge: the RAG pipeline shares this process, and a Node middleware
  // keeps one runtime for the whole request rather than two.
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|brand|favicon.ico).*)"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
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
