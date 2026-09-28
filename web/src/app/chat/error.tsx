"use client";

import type { ReactElement } from "react";

import { RouteError } from "@/components/ui/feedback";

/**
 * Failure boundary for the chat workspace.
 *
 * A streaming failure is contained here rather than tearing down the shell: the
 * transcript is client state, so a retry re-renders the panel without losing the
 * navigation or the session.
 */
export default function ChatError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return <RouteError error={error} reset={reset} />;
}
