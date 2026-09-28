"use client";

import type { ReactElement } from "react";

import { RouteError } from "@/components/ui/feedback";

/** Failure boundary for the evaluation workspace. */
export default function EvaluateError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return <RouteError error={error} reset={reset} />;
}
