import type { NextConfig } from "next";

/**
 * Security headers are declared here rather than in middleware so that static
 * assets served straight from the CDN are covered too. The CSP omits
 * `script-src` nonces on purpose: Next.js injects bootstrap scripts that a
 * nonce-less static header cannot whitelist, and a nonce'd CSP requires the
 * full dynamic-rendering middleware path for every route. Everything else is
 * locked down; `connect-src` stays same-origin because the browser never talks
 * to the LLM provider directly — the FastAPI bridge does.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self'",
      "object-src 'none'",
    ].join("; "),
  },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Server Actions receive PDF uploads; 6 MB of payload plus multipart
    // overhead has to fit inside the body limit.
    serverActions: { bodySizeLimit: "8mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: [...securityHeaders] }];
  },
};

export default nextConfig;
