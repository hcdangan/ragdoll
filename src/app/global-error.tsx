"use client";

import type { ReactElement } from "react";

import { RouteError } from "@/components/ui/feedback";

/**
 * Root error boundary.
 *
 * `global-error.tsx` replaces the whole document when the root layout itself
 * throws, so it cannot rely on the layout's providers or CSS variables being
 * mounted — the styles are inlined for exactly that case.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          // Inline palette values: this boundary renders before globals.css is
          // guaranteed to be mounted, so the brand colours are inlined here.
          background: "#fdf0df",
          color: "#094454",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <RouteError error={error} reset={reset} />
      </body>
    </html>
  );
}
