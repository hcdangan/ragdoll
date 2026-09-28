"use client";

import type { ReactElement } from "react";

import { RouteError } from "@/components/ui/feedback";

/** Route-group error boundary: contains a segment failure, keeps the shell alive. */
export default function SegmentError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return <RouteError error={error} reset={reset} />;
}
