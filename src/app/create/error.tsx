"use client";

import type { ReactElement } from "react";

import { RouteError } from "@/components/ui/feedback";

/**
 * Failure boundary for the creation workspace.
 *
 * A segment-level boundary keeps the navigation and footer alive: a provider
 * error while building the index renders here with a retry, and the user can still
 * move to another route instead of losing the shell to a white screen.
 */
export default function CreateError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return <RouteError error={error} reset={reset} />;
}
