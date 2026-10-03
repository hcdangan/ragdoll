"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";

import { IconDatabase, IconLock } from "@/components/ui/icons";
import { useSession } from "@/hooks/use-session";
import { t } from "@/lib/i18n";

/**
 * Session status pill.
 *
 * Shows the two facts a user needs to trust the app with an API key: how long the
 * sliding window has left, and whether anything is indexed.
 *
 * The countdown ticks locally against the absolute deadline the snapshot reported
 * (`expiresAt`), so it moves every second without polling, and any activity that
 * extends the window shows up as the deadline jumping forward on the next poll.
 */

export function SessionPill(): ReactElement {
  const { pipeline, expiresAt, hasPipeline, snapshot, refetch } = useSession();
  const [now, setNow] = useState(() => Date.now());
  // One refetch per deadline: without this, a server that kept reporting an
  // expired session would be polled once a second for as long as the tab was open.
  const askedFor = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (expiresAt === null || expiresAt - now > 0) {
      askedFor.current = null;
      return;
    }
    if (askedFor.current === expiresAt) {
      return;
    }
    askedFor.current = expiresAt;
    refetch();
  }, [expiresAt, now, refetch]);

  const remaining =
    expiresAt === null ? null : Math.max(0, Math.floor((expiresAt - now) / 1000));
  const expired = remaining !== null && remaining <= 0;

  const format = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  };

  const sharedStore = snapshot?.capabilities.sharedStore ?? true;

  return (
    <div className="hidden items-center gap-2 lg:flex">
      {sharedStore ? null : (
        <span className="badge-warn" title={t("session.noSharedStore")}>
          {t("status.noSharedStore")}
        </span>
      )}
      <span className={hasPipeline ? "badge-brand" : "badge"}>
        <IconDatabase className="h-3.5 w-3.5" />
        {hasPipeline ? (
          // Compact on purpose: the full sentence ("Pipeline ready — 3 chunks
          // from 1 documents") is wide enough to wrap the navigation beside it.
          <span className="whitespace-nowrap" title={t("session.pipelineReady")}>
            {t("session.chunks", { count: pipeline?.chunkCount ?? 0 })}
          </span>
        ) : (
          t("session.pipelineMissing")
        )}
      </span>
      <span
        className={`badge font-mono text-[11px] ${expired ? "badge-danger" : ""}`}
        title={t("session.storageNotice")}
      >
        <IconLock className="h-3.5 w-3.5" />
        {remaining === null ? "--:--" : format(remaining)}
      </span>
    </div>
  );
}
