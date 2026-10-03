"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import type { SessionSnapshot } from "@/app/api/session/route";
import { LIMITS } from "@/lib/rules";
import type { PipelineSummary } from "@/lib/types";

/**
 * The browser's view of the session, refreshed from `/api/session`.
 *
 * Nav gating, chat availability and the "pipeline exists" banner all read from
 * this one query, so they can never disagree with each other. `ttlMs` is the
 * sliding window as the server sees it; the interval is derived from it so a
 * session that is nearly expired refreshes sooner.
 */

export const SESSION_QUERY_KEY = ["ragdoll", "session"] as const;

const fetchSnapshot = async (): Promise<SessionSnapshot> => {
  const response = await fetch("/api/session", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Session snapshot failed with ${response.status}.`);
  }
  return (await response.json()) as SessionSnapshot;
};

export interface SessionView {
  readonly snapshot: SessionSnapshot | undefined;
  readonly pipeline: PipelineSummary | null;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly hasPipeline: boolean;
  readonly canChat: boolean;
  readonly canEvaluate: boolean;
  readonly maskedKey: string | null;
  readonly expiresAt: number | null;
  /** Upload ceilings this deployment can deliver; see `SessionSnapshot`. */
  readonly uploadLimits: { readonly maxFileBytes: number; readonly maxTotalBytes: number };
  readonly refetch: () => void;
}

export const useSession = (): SessionView => {
  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSnapshot,
    refetchInterval: (result) => {
      const ttlMs = result.state.data?.ttlMs ?? 0;
      // Poll often enough that a nearly expired session is caught in time, but
      // never faster than every 20 seconds.
      return Math.max(20_000, Math.min(120_000, Math.floor(ttlMs / 3)));
    },
  });

  const snapshot = query.data;
  const { refetch, dataUpdatedAt } = query;
  // Stable identity: consumers put this in effect dependencies (the countdown
  // that notices expiry, for instance), and an unstable callback would re-fire
  // their effects on every render.
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  /**
   * Absolute expiry, anchored to when the snapshot arrived.
   *
   * `Date.now() + ttlMs` recomputed on every render is what froze the header
   * countdown: each tick re-derived the deadline from the *remaining* lifetime, so
   * the display always showed a full window and only moved when the page reloaded.
   * `dataUpdatedAt` is the moment the server's `ttlMs` was measured, which makes
   * the deadline fixed until the next poll re-anchors it.
   */
  const expiresAt = snapshot === undefined ? null : dataUpdatedAt + snapshot.ttlMs;

  return {
    snapshot,
    pipeline: snapshot?.pipeline ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    hasPipeline: snapshot?.pipeline !== null && snapshot?.pipeline !== undefined,
    canChat: snapshot?.capabilities.chat === true,
    canEvaluate: snapshot?.capabilities.evaluate === true,
    maskedKey: snapshot?.provider?.maskedKey ?? null,
    expiresAt: expiresAt,
    // Falls back to the app's own ceilings until the first snapshot arrives, so the
    // form is never briefly more permissive than the deployment.
    uploadLimits: {
      maxFileBytes: snapshot?.capabilities.maxFileBytes ?? LIMITS.files.maxFileBytes,
      maxTotalBytes: snapshot?.capabilities.maxTotalBytes ?? LIMITS.files.maxTotalBytes,
    },
    refetch: refresh,
  };
};
