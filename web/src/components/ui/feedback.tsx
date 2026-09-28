"use client";

import { useEffect, type ReactElement, type ReactNode } from "react";

import { IconAlert, IconRefresh } from "@/components/ui/icons";
import { t } from "@/lib/i18n";

/**
 * Route-level error surface.
 *
 * AGENTS.md forbids white screens: every failure inside a segment renders this
 * inline panel with a retry that re-runs the segment, while the shell (nav,
 * footer) stays interactive.
 */
export function RouteError({
  error,
  reset,
  title,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
  readonly title?: string;
}): ReactElement {
  useEffect(() => {
    // Surfacing the digest makes a user report actionable without a log dump.
    console.error("Route segment failed", error.digest ?? "", error.message);
  }, [error]);

  return (
    <div role="alert" className="card border-danger/40 bg-danger/5 p-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-danger">
          <IconAlert width={22} height={22} />
        </span>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-ink">{title ?? t("error.boundary.title")}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t("error.boundary.body")}</p>
          <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-muted">
            {error.message || t("error.generic")}
          </p>
          <button type="button" onClick={reset} className="btn-secondary mt-4">
            <IconRefresh className="h-4 w-4" />
            {t("error.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Non-blocking inline notice used for action results. */
export function InlineNotice({
  tone = "info",
  title,
  children,
  action,
}: {
  readonly tone?: "info" | "success" | "warning" | "danger";
  readonly title?: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}): ReactElement {
  const tones = {
    info: "border-cyan-300/50 bg-cyan-50 text-cyan-700",
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    danger: "border-danger/40 bg-danger/10 text-danger",
  } as const;

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${tones[tone]}`}
    >
      <div>
        {title === undefined ? null : <p className="font-semibold">{title}</p>}
        <div className={title === undefined ? "" : "mt-0.5"}>{children}</div>
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Section heading with an optional right-hand control. */
export function SectionHeading({
  title,
  hint,
  action,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {hint === undefined ? null : <p className="field-hint mt-0.5 max-w-2xl">{hint}</p>}
      </div>
      {action === undefined ? null : <div className="mt-2 shrink-0 sm:mt-0">{action}</div>}
    </div>
  );
}
